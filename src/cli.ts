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
import { runMcpProxy } from "./proxy.js";
import { PACKAGE_VERSION } from "./version.js";

const CLIENTS: AgentClient[] = ["claude", "claude-code", "cursor", "codex"];

type SetupOptions = {
  url?: string;
  token?: string;
  profile: string;
  clients?: string;
  yes?: boolean;
  noValidate?: boolean;
  noSkill?: boolean;
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

async function runSetup(options: SetupOptions): Promise<void> {
  const resolved = await promptMissing(options);
  if (!resolved.url || !resolved.token) {
    throw new Error("Both Cograph URL and token are required");
  }

  if (!options.noValidate) {
    const count = await validateRemote({
      url: resolved.url,
      token: resolved.token,
    });
    console.log(`Validated remote MCP endpoint. Tools available: ${count}`);
  }

  const config = await upsertProfile({
    profileName: options.profile,
    url: resolved.url,
    token: resolved.token,
  });
  const profile = config.profiles[options.profile];
  console.log(`Saved profile "${options.profile}" to ${configPath()}`);
  console.log(`Token: ${redactToken(profile.token)}`);

  for (const client of resolved.clients) {
    try {
      printClientResult(await configureClient(client, options.profile));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`${client}: could not update config: ${message}`);
      console.error(`Manual snippet:\n${manualSnippet(client, options.profile)}`);
    }
  }

  if (!options.noSkill) {
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
  .command("mcp")
  .description("Run the local stdio MCP proxy.")
  .option("--profile <name>", "Profile name")
  .action(async ({ profile }: { profile?: string }) => runMcpProxy(profile));

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
  const message = error instanceof Error ? error.message : String(error);
  console.error(message.replace(/Bearer\s+\S+/gi, "Bearer <redacted>"));
  process.exitCode = 1;
});
