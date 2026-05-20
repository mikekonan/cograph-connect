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

const MCP_REMOTE_PACKAGE = "mcp-remote";

/**
 * Codex's TOML config refuses an inline `bearer_token = "…"`: the CLI parses
 * it but the MCP client doesn't apply it as an Authorization header, so the
 * server sees an anonymous request and the session 401s. The only shape that
 * actually works end-to-end is `bearer_token_env_var = "NAME"` with the
 * matching `export NAME=…` in the shell. The `default` profile gets the bare
 * `COGRAPH_TOKEN` (matches the convention every other client uses); other
 * profiles get `COGRAPH_TOKEN_<UPPER_SANITIZED>` so a multi-profile setup
 * doesn't collide.
 */
export function codexEnvVarName(profileName: string): string {
  if (profileName === "default") return "COGRAPH_TOKEN";
  const sanitized = profileName.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  const trimmed = sanitized.replace(/^_+|_+$/g, "");
  return trimmed ? `COGRAPH_TOKEN_${trimmed}` : "COGRAPH_TOKEN";
}

/**
 * Builds the MCP server entry to write into each client's config.
 *
 * Claude Code and Cursor accept a direct remote-HTTP entry — we write the URL
 * and inline `Authorization: Bearer …` header straight into the config.
 *
 * Codex serialises to TOML separately (see `mergeCodexTomlConfig`) and uses
 * `bearer_token_env_var` — the only token-binding form its CLI honours; the
 * `buildEntry` return for `codex` exists only for type-completeness and is
 * never written to disk.
 *
 * Claude Desktop is the exception: its `claude_desktop_config.json` validator
 * only accepts stdio MCP servers (`command` + `args`); the official remote-HTTP
 * path lives in `Settings → Connectors`, not in the JSON file. Writing a
 * `{ type: "http", url, headers }` entry produces a
 * "not valid MCP server configurations and were skipped: cograph" warning at
 * startup. So for Claude Desktop we shell out to the community
 * [`mcp-remote`](https://github.com/geelen/mcp-remote) stdio→HTTP bridge with
 * `NODE_OPTIONS=--use-system-ca` so its Node trusts whatever the OS trust
 * store trusts (covers corporate CAs without extra config).
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
        bearer_token_env_var: codexEnvVarName(profileName),
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
  const newEntry = buildEntry(client, profileName, profile);
  // Detect "the previous entry used the npx/mcp-remote stdio bridge but the
  // new shape doesn't" — that's the migration we want to surface. Claude
  // Desktop legitimately uses the bridge today (its config validator rejects
  // remote HTTP), so a npx-shaped existing entry there is NOT legacy.
  const newEntryIsNpxBridge = isNpxMcpRemoteEntry(newEntry);
  const removedNpxBridge =
    !newEntryIsNpxBridge &&
    (isNpxMcpRemoteEntry(existingCograph) || isNpxMcpRemoteEntry(legacyEntry));
  record.mcpServers = {
    ...rest,
    [MCP_SERVER_NAME]: newEntry,
  };
  return {
    content: `${JSON.stringify(record, null, 2)}\n`,
    removedLegacy,
    removedNpxBridge,
  };
}

/**
 * The 0.6.0–0.7.0 cograph-connect inlined the token as `bearer_token = "…"`
 * directly into the Codex TOML block. The Codex CLI parses that key but the
 * MCP runtime never reads it as an Authorization header — every session 401s
 * silently. We now revert to `bearer_token_env_var = "<NAME>"` (the only
 * binding form Codex actually applies) and rely on the user exporting the
 * matching env var in their shell. If the legacy inline-token block is still
 * there, strip it cleanly and report it via `removedNpxBridge` so the CLI
 * can announce the migration in the same channel as other legacy cleanups.
 *
 * (The flag name is `removedNpxBridge` for symmetry with the JSON path —
 * "we cleaned up a legacy non-direct-HTTP setup". Codex never used npx, but
 * the inlined-token shape was the same kind of broken-coupling cleanup as
 * the JSON-side bridge removal.)
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
  let removedInlineTokenBlock = false;
  let currentBlockHasInlineToken = false;
  for (const line of lines) {
    if (/^\s*\[mcp_servers\.cograph\]\s*$/.test(line)) {
      skipping = true;
      currentBlockHasInlineToken = false;
      continue;
    }
    if (/^\s*\[mcp_servers\.gitnexus\]\s*$/.test(line)) {
      skipping = true;
      removedLegacy = true;
      currentBlockHasInlineToken = false;
      continue;
    }
    if (skipping) {
      // `bearer_token =` only — exclude `bearer_token_env_var =` (that's the
      // good shape; if it's already there we're idempotently rewriting it
      // and there's nothing to migrate).
      if (/^\s*bearer_token\s*=/.test(line)) {
        currentBlockHasInlineToken = true;
      }
      if (/^\s*\[/.test(line)) {
        if (currentBlockHasInlineToken) removedInlineTokenBlock = true;
        skipping = false;
        currentBlockHasInlineToken = false;
      }
    }
    if (!skipping) {
      output.push(line);
    }
  }
  if (skipping && currentBlockHasInlineToken) removedInlineTokenBlock = true;
  while (output.length > 0 && output[output.length - 1] === "") {
    output.pop();
  }
  const envVarName = codexEnvVarName(profileName);
  const block = [
    "[mcp_servers.cograph]",
    `url = ${JSON.stringify(profile.url)}`,
    `bearer_token_env_var = ${JSON.stringify(envVarName)}`,
  ];
  return {
    content: `${output.length ? `${output.join("\n")}\n\n` : ""}${block.join("\n")}\n`,
    removedLegacy,
    removedNpxBridge: removedInlineTokenBlock,
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
