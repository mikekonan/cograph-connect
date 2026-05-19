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
  /** True when an old npx/mcp-remote bridge entry was found and replaced by direct HTTP. */
  removedNpxBridge?: boolean;
};

export type MergeResult = {
  content: string;
  removedLegacy: boolean;
  removedNpxBridge: boolean;
};

export const MCP_SERVER_NAME = "cograph";
export const LEGACY_MCP_SERVER_NAME = "gitnexus";

/**
 * Builds the MCP server entry to write into each client's config.
 *
 * Every client gets the same shape: direct HTTP with an inline `Authorization:
 * Bearer …` header. No npx, no env-var dance, no stdio bridge. Claude Desktop's
 * config schema now accepts `type: "http"` natively, so we no longer shell out
 * through the community `mcp-remote` package — and the corporate-CA story is
 * handled by the client's own HTTP stack (OS trust store), not by Node.
 */
function buildEntry(
  client: AgentClient,
  _profileName: string,
  profile: Profile,
): Record<string, unknown> {
  switch (client) {
    case "claude":
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
        bearer_token: profile.token,
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

/**
 * An old `cograph` entry written by cograph-connect ≤0.4.x bridged Claude
 * Desktop through `npx -y mcp-remote …`. Detect that shape so we can announce
 * the cleanup. The check is intentionally conservative — we only treat it as a
 * "npx bridge" if the command is npx AND the args reference mcp-remote.
 */
function isNpxMcpRemoteEntry(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") return false;
  const record = entry as Record<string, unknown>;
  if (record.command !== "npx") return false;
  const args = Array.isArray(record.args) ? record.args : [];
  return args.some(
    (arg) => typeof arg === "string" && arg.includes("mcp-remote"),
  );
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
  const {
    [LEGACY_MCP_SERVER_NAME]: legacyEntry,
    [MCP_SERVER_NAME]: existingCograph,
    ...rest
  } = existingServers;
  const removedLegacy = legacyEntry !== undefined;
  const removedNpxBridge =
    isNpxMcpRemoteEntry(existingCograph) || isNpxMcpRemoteEntry(legacyEntry);
  record.mcpServers = {
    ...rest,
    [MCP_SERVER_NAME]: buildEntry(client, profileName, profile),
  };
  return {
    content: `${JSON.stringify(record, null, 2)}\n`,
    removedLegacy,
    removedNpxBridge,
  };
}

/**
 * The previous cograph-connect wrote `bearer_token_env_var = "COGRAPH_TOKEN_…"`
 * into the TOML block and told the user to add an `export …` line to their
 * shell rc. We now inline the token instead — but if the old block is still
 * there, strip it cleanly and report `removedNpxBridge` so the CLI can
 * surface that the user no longer needs that env var.
 *
 * (The flag name is `removedNpxBridge` for symmetry with the JSON path —
 * "we cleaned up a legacy non-direct-HTTP setup". Codex never used npx, but
 * the env-var dance was the same kind of out-of-band coupling and is removed
 * by the same code path.)
 */
export function mergeCodexTomlConfig(
  raw: string | null,
  profileName: string,
  profile: Profile,
): MergeResult {
  const lines = (raw ?? "").split(/\r?\n/);
  const output: string[] = [];
  let skipping = false;
  let removedLegacy = false;
  let removedEnvVarBlock = false;
  let currentBlockHasEnvVar = false;
  for (const line of lines) {
    if (/^\s*\[mcp_servers\.cograph\]\s*$/.test(line)) {
      skipping = true;
      currentBlockHasEnvVar = false;
      continue;
    }
    if (/^\s*\[mcp_servers\.gitnexus\]\s*$/.test(line)) {
      skipping = true;
      removedLegacy = true;
      currentBlockHasEnvVar = false;
      continue;
    }
    if (skipping) {
      if (/^\s*bearer_token_env_var\s*=/.test(line)) {
        currentBlockHasEnvVar = true;
      }
      if (/^\s*\[/.test(line)) {
        if (currentBlockHasEnvVar) removedEnvVarBlock = true;
        skipping = false;
        currentBlockHasEnvVar = false;
      }
    }
    if (!skipping) {
      output.push(line);
    }
  }
  if (skipping && currentBlockHasEnvVar) removedEnvVarBlock = true;
  while (output.length > 0 && output[output.length - 1] === "") {
    output.pop();
  }
  // Profile name is preserved in the input signature for future per-profile
  // TOML tables (currently the single `[mcp_servers.cograph]` is shared).
  void profileName;
  const block = [
    "[mcp_servers.cograph]",
    `url = ${JSON.stringify(profile.url)}`,
    `bearer_token = ${JSON.stringify(profile.token)}`,
  ];
  return {
    content: `${output.length ? `${output.join("\n")}\n\n` : ""}${block.join("\n")}\n`,
    removedLegacy,
    removedNpxBridge: removedEnvVarBlock,
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
      removedNpxBridge: false,
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
    removedNpxBridge: merged.removedNpxBridge,
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
