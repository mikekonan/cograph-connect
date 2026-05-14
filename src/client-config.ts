import fs from "node:fs/promises";
import path from "node:path";

import { type Profile } from "./config.js";
import { AgentClient, clientConfigPath } from "./paths.js";

export type ClientWriteResult = {
  client: AgentClient;
  path: string;
  changed: boolean;
  backupPath?: string;
  removedLegacy?: boolean;
  /** Codex requires the token in an env var; surfaces the name so setup can instruct the user. */
  codexTokenEnvVar?: string;
};

export type MergeResult = {
  content: string;
  removedLegacy: boolean;
  codexTokenEnvVar?: string;
};

export const MCP_SERVER_NAME = "cograph";
export const LEGACY_MCP_SERVER_NAME = "gitnexus";

const MCP_REMOTE_PACKAGE = "mcp-remote";

export function codexTokenEnvVarName(profileName: string): string {
  const normalized = profileName.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase();
  return `COGRAPH_TOKEN_${normalized || "DEFAULT"}`;
}

/**
 * Builds the MCP server entry to write into each client's config.
 *
 * Three of the four supported clients accept a direct remote-HTTP entry, so
 * setup writes the URL + Authorization header straight into the config.
 * Claude Desktop's JSON config schema is stdio-only — for that client we shell
 * out to the community `mcp-remote` stdio→HTTP bridge with
 * `NODE_OPTIONS=--use-system-ca` so its Node trusts whatever the OS trust
 * store trusts (closes the corporate-CA hole that bites a custom local proxy).
 */
function buildEntry(
  client: AgentClient,
  profileName: string,
  profile: Profile,
): Record<string, unknown> {
  switch (client) {
    case "claude":
      return {
        command: "npx",
        args: [
          "-y",
          MCP_REMOTE_PACKAGE,
          profile.url,
          "--header",
          `Authorization: Bearer ${profile.token}`,
        ],
        env: { NODE_OPTIONS: "--use-system-ca" },
      };
    case "claude-code":
      return {
        type: "http",
        url: profile.url,
        headers: { Authorization: `Bearer ${profile.token}` },
      };
    case "cursor":
      return {
        url: profile.url,
        headers: { Authorization: `Bearer ${profile.token}` },
      };
    case "codex":
      // Codex serialises separately (TOML). Unused here but kept for typing.
      return {
        url: profile.url,
        bearer_token_env_var: codexTokenEnvVarName(profileName),
      };
  }
}

async function backupIfExists(filePath: string): Promise<string | undefined> {
  try {
    await fs.stat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const backupPath = `${filePath}.bak.${new Date()
    .toISOString()
    .replace(/[:.]/g, "-")}`;
  await fs.copyFile(filePath, backupPath);
  return backupPath;
}

async function readTextIfExists(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function mergeJsonMcpConfig(
  raw: string | null,
  client: AgentClient,
  profileName: string,
  profile: Profile,
): MergeResult {
  const parsed = raw?.trim() ? JSON.parse(raw) : {};
  const root =
    parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  const record = root as Record<string, unknown>;
  const existingServers =
    record.mcpServers &&
    typeof record.mcpServers === "object" &&
    !Array.isArray(record.mcpServers)
      ? (record.mcpServers as Record<string, unknown>)
      : {};
  const { [LEGACY_MCP_SERVER_NAME]: legacyEntry, ...rest } = existingServers;
  const removedLegacy = legacyEntry !== undefined;
  record.mcpServers = {
    ...rest,
    [MCP_SERVER_NAME]: buildEntry(client, profileName, profile),
  };
  return {
    content: `${JSON.stringify(record, null, 2)}\n`,
    removedLegacy,
  };
}

export function mergeCodexTomlConfig(
  raw: string | null,
  profileName: string,
  profile: Profile,
): MergeResult {
  const lines = (raw ?? "").split(/\r?\n/);
  const output: string[] = [];
  let skipping = false;
  let removedLegacy = false;
  for (const line of lines) {
    if (/^\s*\[mcp_servers\.cograph\]\s*$/.test(line)) {
      skipping = true;
      continue;
    }
    if (/^\s*\[mcp_servers\.gitnexus\]\s*$/.test(line)) {
      skipping = true;
      removedLegacy = true;
      continue;
    }
    if (skipping && /^\s*\[/.test(line)) {
      skipping = false;
    }
    if (!skipping) {
      output.push(line);
    }
  }
  while (output.length > 0 && output[output.length - 1] === "") {
    output.pop();
  }
  const envVarName = codexTokenEnvVarName(profileName);
  const block = [
    "[mcp_servers.cograph]",
    `url = ${JSON.stringify(profile.url)}`,
    `bearer_token_env_var = ${JSON.stringify(envVarName)}`,
  ];
  return {
    content: `${output.length ? `${output.join("\n")}\n\n` : ""}${block.join("\n")}\n`,
    removedLegacy,
    codexTokenEnvVar: envVarName,
  };
}

export async function configureClient(
  client: AgentClient,
  profileName: string,
  profile: Profile,
  filePath = clientConfigPath(client),
): Promise<ClientWriteResult> {
  const raw = await readTextIfExists(filePath);
  const merged =
    client === "codex"
      ? mergeCodexTomlConfig(raw, profileName, profile)
      : mergeJsonMcpConfig(raw, client, profileName, profile);
  if (raw === merged.content) {
    return {
      client,
      path: filePath,
      changed: false,
      removedLegacy: false,
      codexTokenEnvVar: merged.codexTokenEnvVar,
    };
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const backupPath = await backupIfExists(filePath);
  await fs.writeFile(filePath, merged.content, "utf8");
  return {
    client,
    path: filePath,
    changed: true,
    backupPath,
    removedLegacy: merged.removedLegacy,
    codexTokenEnvVar: merged.codexTokenEnvVar,
  };
}

export function manualSnippet(
  client: AgentClient,
  profileName: string,
  profile: Profile,
): string {
  if (client === "codex") {
    return mergeCodexTomlConfig("", profileName, profile).content.trimEnd();
  }
  return JSON.stringify(
    { mcpServers: { [MCP_SERVER_NAME]: buildEntry(client, profileName, profile) } },
    null,
    2,
  );
}
