#!/usr/bin/env node
import { Command } from "commander";
import prompts from "prompts";

import {
  publicConfig,
  readConfig,
  redactToken,
  upsertProfile,
} from "./config.js";
import {
  configureClient,
  manualSnippet,
  type ClientWriteResult,
} from "./client-config.js";
import { configPath, type AgentClient, packageRoot } from "./paths.js";
import { validateRemote } from "./remote.js";
import { installSkill } from "./skill.js";
import { PACKAGE_VERSION } from "./version.js";

const CLIENTS: AgentClient[] = ["claude", "claude-code", "cursor", "codex"];

function walkErrorChain(error: unknown): Error[] {
  const chain: Error[] = [];
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current && !seen.has(current)) {
    seen.add(current);
    if (current instanceof Error) {
      chain.push(current);
      current = (current as { cause?: unknown }).cause;
    } else {
      chain.push(new Error(String(current)));
      break;
    }
  }
  return chain;
}

function formatErrorChain(error: unknown): string {
  return walkErrorChain(error)
    .map((err) => {
      const code = (err as NodeJS.ErrnoException).code;
      return code ? `${err.message} [${code}]` : err.message;
    })
    .join(" → ");
}

const TLS_TRUST_CODES = new Set([
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "CERT_UNTRUSTED",
]);

function diagnoseRemoteError(error: unknown): string {
  const codes = walkErrorChain(error)
    .map((err) => (err as NodeJS.ErrnoException).code)
    .filter((code): code is string => Boolean(code));

  if (codes.some((c) => TLS_TRUST_CODES.has(c))) {
    return "TLS: Node does not trust the certificate issuer. If your Cograph instance uses a corporate or self-signed CA, set NODE_EXTRA_CA_CERTS=/path/to/ca.pem and re-run. Note: MCP clients (Claude Desktop / Code / Cursor / Codex) also need this env var when they launch the proxy — set it system-wide, or add an `env` block to the MCP server config they wrote.";
  }
  if (codes.includes("CERT_HAS_EXPIRED")) {
    return "TLS: the server certificate is expired. This is a backend issue — contact the Cograph operator.";
  }
  if (codes.includes("ENOTFOUND")) {
    return "DNS: hostname does not resolve. Usually means VPN is not connected, or the URL has a typo.";
  }
  if (codes.includes("ECONNREFUSED")) {
    return "Connection refused: the host is reachable but nothing listens on that port. Check the URL/port.";
  }
  if (codes.includes("ECONNRESET") || codes.includes("ETIMEDOUT")) {
    return "Network: the connection was dropped or timed out. A corporate proxy / firewall is the usual suspect.";
  }
  return "Common causes: VPN is not connected, the Cograph hostname is private to your network, the backend is briefly returning 502/504, or a corporate proxy blocks the request.";
}

type SetupOptions = {
  url?: string;
  token?: string;
  profile: string;
  clients?: string;
  yes?: boolean;
  validate?: boolean;
  skill?: boolean;
};

function parseClients(value?: string): AgentClient[] | undefined {
  if (!value) return undefined;
  const parsed = value
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  for (const client of parsed) {
    if (!CLIENTS.includes(client as AgentClient)) {
      throw new Error(`Unknown client: ${client}. Use: ${CLIENTS.join(", ")}`);
    }
  }
  return parsed as AgentClient[];
}

async function promptMissing(options: SetupOptions): Promise<{
  url: string;
  token: string;
  clients: AgentClient[];
}> {
  if (options.yes) {
    if (!options.url) {
      throw new Error("--url is required when using -y");
    }
    if (!options.token) {
      throw new Error("--token is required when using -y");
    }
  }

  const questions: prompts.PromptObject[] = [];
  if (!options.url) {
    questions.push({
      type: "text",
      name: "url",
      message: "Cograph URL",
    });
  }
  if (!options.token) {
    questions.push({
      type: "password",
      name: "token",
      message: "Cograph PAT token",
    });
  }
  let selectedClients = parseClients(options.clients);
  if (!selectedClients && !options.yes) {
    questions.push({
      type: "multiselect",
      name: "clients",
      message: "Configure agent clients",
      choices: [
        { title: "Claude Desktop", value: "claude", selected: true },
        { title: "Claude Code", value: "claude-code", selected: true },
        { title: "Cursor", value: "cursor", selected: true },
        { title: "Codex", value: "codex", selected: true },
      ],
      min: 0,
    });
  }
  const answers = questions.length
    ? await prompts(questions, {
        onCancel: () => {
          throw new Error("Setup cancelled");
        },
      })
    : {};
  selectedClients =
    selectedClients || (options.yes ? CLIENTS : ((answers.clients ?? []) as AgentClient[]));
  return {
    url: options.url || answers.url,
    token: options.token || answers.token,
    clients: selectedClients,
  };
}

function printClientResult(result: ClientWriteResult): void {
  const action = result.changed ? "configured" : "already configured";
  console.log(`${result.client}: ${action} at ${result.path}`);
  if (result.backupPath) {
    console.log(`${result.client}: backup written to ${result.backupPath}`);
  }
  if (result.removedLegacy) {
    console.log(
      `${result.client}: removed legacy gitnexus MCP entry (replaced by cograph)`,
    );
  }
}

function quoteForShell(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

async function runSetup(options: SetupOptions): Promise<void> {
  const resolved = await promptMissing(options);
  if (!resolved.url || !resolved.token) {
    throw new Error("Both Cograph URL and token are required");
  }

  let validationError: unknown = null;
  if (options.validate !== false) {
    try {
      const count = await validateRemote({
        url: resolved.url,
        token: resolved.token,
      });
      console.log(`Validated remote MCP endpoint. Tools available: ${count}`);
    } catch (error) {
      validationError = error;
    }
  }

  const config = await upsertProfile({
    profileName: options.profile,
    url: resolved.url,
    token: resolved.token,
  });
  const profile = config.profiles[options.profile];
  console.log(`Saved profile "${options.profile}" to ${configPath()}`);
  console.log(`Token: ${redactToken(profile.token)}`);

  const codexInstructions: { envVar: string; token: string }[] = [];
  for (const client of resolved.clients) {
    try {
      const result = await configureClient(client, options.profile, profile);
      printClientResult(result);
      if (client === "codex" && result.codexTokenEnvVar) {
        codexInstructions.push({
          envVar: result.codexTokenEnvVar,
          token: profile.token,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`${client}: could not update config: ${message}`);
      console.error(
        `Manual snippet:\n${manualSnippet(client, options.profile, profile)}`,
      );
    }
  }

  if (options.skill !== false) {
    const installed = await installSkill({
      packageRoot: packageRoot(import.meta.url),
      clients: resolved.clients,
    });
    if (installed.length === 0) {
      console.log("skill: no selected client supports skill install (skipped)");
    } else {
      for (const { client, target } of installed) {
        console.log(`${client} skill: installed at ${target}`);
      }
    }
  }

  if (codexInstructions.length > 0) {
    console.log("");
    console.log(
      "Codex reads the PAT from an environment variable (the token is NOT stored in ~/.codex/config.toml).",
    );
    console.log("Add this to your shell rc (e.g. ~/.zshenv) and reload:");
    for (const { envVar, token } of codexInstructions) {
      console.log(`  export ${envVar}=${quoteForShell(token)}`);
    }
  }

  if (validationError) {
    const reason = formatErrorChain(validationError).replace(
      /Bearer\s+\S+/gi,
      "Bearer <redacted>",
    );
    const diagnosis = diagnoseRemoteError(validationError);
    console.warn("");
    console.warn(`Warning: could not validate remote Cograph MCP — ${reason}`);
    console.warn(`Profile and client configs were saved anyway. ${diagnosis}`);
    console.warn(
      "Once fixed, run `cograph-connect status --check` to verify the profile.",
    );
  }
}

async function runStatus({ check }: { check?: boolean }): Promise<void> {
  const config = await readConfig();
  if (!config) {
    console.log("cograph-connect is not configured.");
    return;
  }
  console.log(JSON.stringify(publicConfig(config), null, 2));
  if (check) {
    const profile = config.profiles[config.defaultProfile];
    const count = await validateRemote(profile);
    console.log(`Remote MCP check passed. Tools available: ${count}`);
  }
}

const program = new Command();
program
  .name("cograph-connect")
  .description("Connect Cograph to agent clients through MCP and Codex skills.")
  .version(PACKAGE_VERSION);

program
  .command("setup")
  .description("Configure Cograph MCP access for local agent clients.")
  .option("--url <url>", "Cograph base URL or /mcp/ URL")
  .option("--token <token>", "Cograph PAT token")
  .option("--profile <name>", "Profile name", "default")
  .option(
    "--clients <list>",
    `Comma-separated clients: ${CLIENTS.join(",")}`,
  )
  .option("-y, --yes", "Non-interactive (requires --url and --token)")
  .option("--no-validate", "Skip remote MCP validation")
  .option("--no-skill", "Skip SKILL.md install for clients that support it")
  .action(async (options: SetupOptions) => runSetup(options));

program
  .command("status")
  .description("Print configured profiles with redacted tokens.")
  .option("--check", "Validate the default profile against remote Cograph")
  .action(async (options: { check?: boolean }) => runStatus(options));

program
  .command("config")
  .description("Config utilities.")
  .command("print")
  .description("Print cograph-connect config with redacted tokens.")
  .action(async () => runStatus({ check: false }));

program.parseAsync().catch((error: unknown) => {
  const message = formatErrorChain(error);
  console.error(message.replace(/Bearer\s+\S+/gi, "Bearer <redacted>"));
  process.exitCode = 1;
});
