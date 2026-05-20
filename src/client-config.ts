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
 * MCP runtime never reads it as an Authorization header — every session
 * 401s silently. The only binding form Codex actually applies is
 * `bearer_token_env_var = "<NAME>"`, which makes Codex look up that env
 * var name at MCP-connect time.
 *
 * 0.8.0 reverted to `bearer_token_env_var` but pushed the env-export burden
 * onto the user (manual `export COGRAPH_TOKEN=…` in `~/.zshrc` for CLI and
 * `launchctl setenv` for Desktop — two different mechanisms, easy to miss
 * one). 0.8.1 closes that gap by writing the token into Codex's own
 * `[shell_environment_policy.set]` block, which Codex injects into the env
 * of every MCP child process it spawns. Both CLI and Desktop read the same
 * `~/.codex/config.toml`, so a single edit covers both — no shell rc, no
 * launchctl, no LaunchAgent.
 *
 * The merge needs to handle three sections:
 *  - `[mcp_servers.cograph]` — fully replaced; pre-existing inline
 *    `bearer_token = …` is treated as legacy (the 0.6.0–0.7.0 regression)
 *    and surfaced via `removedNpxBridge`.
 *  - `[mcp_servers.gitnexus]` — legacy server name from gitnexus era;
 *    dropped entirely and surfaced via `removedLegacy`.
 *  - `[shell_environment_policy.set]` — MERGED, not replaced. Other keys
 *    (CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR, USE_BUILTIN_RIPGREP, etc.)
 *    are preserved verbatim; only our managed `COGRAPH_TOKEN[_PROFILE]` key
 *    is rewritten. If the section doesn't exist yet, it's created.
 *
 * The flag name `removedNpxBridge` is kept for symmetry with the JSON
 * code path — "we cleaned up a legacy non-direct-HTTP setup". Codex never
 * used npx, but the inline-token shape was the same kind of broken-
 * coupling cleanup as the JSON-side bridge removal.
 */
export function mergeCodexTomlConfig(
  raw: string | null,
  profileName: string,
  profile: Profile,
): MergeResult {
  const envVarName = codexEnvVarName(profileName);
  const managedTokenLine = `${envVarName} = ${JSON.stringify(profile.token)}`;
  const lines = (raw ?? "").split(/\r?\n/);
  const output: string[] = [];

  let removedLegacy = false;
  let removedInlineTokenBlock = false;
  let mode: "default" | "skip-cograph" | "skip-gitnexus" | "shell-env" =
    "default";
  let currentBlockHasInlineToken = false;
  let shellEnvSectionFound = false;

  const closeMode = () => {
    if (mode === "skip-cograph" && currentBlockHasInlineToken) {
      removedInlineTokenBlock = true;
    }
    if (mode === "shell-env") {
      // Append our managed token line at the end of the shell-env block
      // (other keys from the user's existing config were emitted as-is
      // during the section; we re-emit our managed key here so it's
      // always present and points at the latest token value).
      output.push(managedTokenLine);
    }
    currentBlockHasInlineToken = false;
    mode = "default";
  };

  for (const line of lines) {
    const isHeader = /^\s*\[/.test(line);
    if (isHeader && mode !== "default") {
      closeMode();
      // Fall through to default-mode processing of this new header.
    }
    if (mode === "default") {
      if (/^\s*\[mcp_servers\.cograph\]\s*$/.test(line)) {
        mode = "skip-cograph";
        continue;
      }
      if (/^\s*\[mcp_servers\.gitnexus\]\s*$/.test(line)) {
        mode = "skip-gitnexus";
        removedLegacy = true;
        continue;
      }
      if (/^\s*\[shell_environment_policy\.set\]\s*$/.test(line)) {
        mode = "shell-env";
        shellEnvSectionFound = true;
        output.push(line);
        continue;
      }
      output.push(line);
      continue;
    }
    if (mode === "skip-cograph") {
      if (/^\s*bearer_token\s*=/.test(line)) {
        currentBlockHasInlineToken = true;
      }
      continue;
    }
    if (mode === "skip-gitnexus") {
      continue;
    }
    if (mode === "shell-env") {
      // Strip any pre-existing line for OUR managed key — we re-emit it via
      // closeMode() so the value always reflects the current profile.token.
      // Other keys in the section are preserved verbatim.
      const keyMatch = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
      if (keyMatch && keyMatch[1] === envVarName) {
        continue;
      }
      output.push(line);
      continue;
    }
  }
  closeMode();

  while (output.length > 0 && output[output.length - 1] === "") {
    output.pop();
  }

  let prelude = output.join("\n");
  if (!shellEnvSectionFound) {
    const newSection = `[shell_environment_policy.set]\n${managedTokenLine}`;
    prelude = prelude.length ? `${prelude}\n\n${newSection}` : newSection;
  }

  const cographBlock = [
    "[mcp_servers.cograph]",
    `url = ${JSON.stringify(profile.url)}`,
    `bearer_token_env_var = ${JSON.stringify(envVarName)}`,
  ];
  return {
    content: `${prelude.length ? `${prelude}\n\n` : ""}${cographBlock.join("\n")}\n`,
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
