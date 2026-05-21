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
  let removedLegacy = legacyEntry !== undefined;
  const newEntry = buildEntry(client, profileName, profile);
  // Detect "the previous entry used the npx/mcp-remote stdio bridge but the
  // new shape doesn't" — that's the migration we want to surface. Claude
  // Desktop legitimately uses the bridge today (its config validator rejects
  // remote HTTP), so a npx-shaped existing entry there is NOT legacy.
  const newEntryIsNpxBridge = isNpxMcpRemoteEntry(newEntry);
  let removedNpxBridge =
    !newEntryIsNpxBridge &&
    (isNpxMcpRemoteEntry(existingCograph) || isNpxMcpRemoteEntry(legacyEntry));
  record.mcpServers = {
    ...rest,
    [MCP_SERVER_NAME]: newEntry,
  };

  if (client === "claude-code") {
    // Claude Code's per-project `projects.<path>.mcpServers` REPLACES the
    // top-level mcpServers — it does NOT merge with it. So if any directory
    // has a per-project override (added implicitly when the user configures
    // even one other server like archon or codex-cli in that directory),
    // cograph will be invisible there unless its entry is also written into
    // that per-project block.
    //
    // Likewise, when `setup` runs a second time with a re-issued PAT, the
    // top-level cograph entry gets the new token but every per-project
    // block still has the old token → silent 401s in those directories.
    //
    // We propagate the fresh entry into every existing per-project
    // mcpServers block (replacing stale cograph entries, adding it where
    // missing). Projects WITHOUT a per-project mcpServers block are left
    // alone — they correctly inherit the top-level entry.
    //
    // Only applies to claude-code: cursor and claude (Desktop) use
    // separate flat config files without a `projects.*` structure.
    const projects = record.projects;
    if (projects && typeof projects === "object" && !Array.isArray(projects)) {
      const projectsRecord = projects as Record<string, unknown>;
      for (const projPath of Object.keys(projectsRecord)) {
        const proj = projectsRecord[projPath];
        if (!proj || typeof proj !== "object" || Array.isArray(proj)) continue;
        const projObj = proj as Record<string, unknown>;
        const projServers = projObj.mcpServers;
        if (
          !projServers ||
          typeof projServers !== "object" ||
          Array.isArray(projServers)
        ) {
          continue;
        }
        const servers = projServers as Record<string, unknown>;
        const {
          [LEGACY_MCP_SERVER_NAME]: projLegacy,
          [MCP_SERVER_NAME]: projExisting,
          ...projRest
        } = servers;
        if (projLegacy !== undefined) removedLegacy = true;
        if (
          !newEntryIsNpxBridge &&
          (isNpxMcpRemoteEntry(projExisting) || isNpxMcpRemoteEntry(projLegacy))
        ) {
          removedNpxBridge = true;
        }
        projObj.mcpServers = {
          ...projRest,
          [MCP_SERVER_NAME]: newEntry,
        };
      }
    }
  }

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
/**
 * A TOML section as we re-emit it: the bracketed header (e.g.
 * `[shell_environment_policy.set]`) plus the lines that belong to it. The
 * implicit "preamble" before any header (top-level keys like `model = "..."`)
 * is represented with `header: null`.
 *
 * We don't try to parse values — just preserve them as-is. The only
 * structured manipulation we do is at the section level (drop, append, or
 * filter individual key lines inside one section).
 */
type TomlSection = {
  header: string | null;
  lines: string[];
};

function parseTomlSections(raw: string): TomlSection[] {
  const sections: TomlSection[] = [{ header: null, lines: [] }];
  for (const line of raw.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) {
      sections.push({ header: line, lines: [] });
    } else {
      sections[sections.length - 1].lines.push(line);
    }
  }
  return sections;
}

function emitTomlSections(sections: TomlSection[]): string {
  const blocks: string[] = [];
  for (const sec of sections) {
    const lines = [...sec.lines];
    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    while (lines.length > 0 && lines[0] === "") lines.shift();
    // Skip an empty preamble (no header, no content) so the output doesn't
    // start with a stray blank line.
    if (sec.header === null && lines.length === 0) continue;
    const block: string[] = [];
    if (sec.header !== null) block.push(sec.header);
    for (const l of lines) block.push(l);
    blocks.push(block.join("\n"));
  }
  // Exactly one blank line between sections (TOML doesn't require it, but it
  // matches how every other tool that touches config.toml writes it).
  return blocks.length ? `${blocks.join("\n\n")}\n` : "";
}

/**
 * 0.6.0–0.7.0 cograph-connect inlined the token as `bearer_token = "…"`
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
 * The merge is structured at the SECTION level (parse → mutate → re-emit)
 * rather than line-by-line, so blank-line separators between sections are
 * preserved cleanly and the managed `COGRAPH_TOKEN` key always lands at the
 * end of `[shell_environment_policy.set]` regardless of how the surrounding
 * file is formatted.
 *
 * Three sections are managed:
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
 * code path — "we cleaned up a legacy non-direct-HTTP setup".
 */
export function mergeCodexTomlConfig(
  raw: string | null,
  profileName: string,
  profile: Profile,
): MergeResult {
  const envVarName = codexEnvVarName(profileName);
  const managedTokenLine = `${envVarName} = ${JSON.stringify(profile.token)}`;
  const cographHeader = "[mcp_servers.cograph]";
  const shellEnvHeader = "[shell_environment_policy.set]";

  const sections = parseTomlSections(raw ?? "");
  let removedLegacy = false;
  let removedInlineTokenBlock = false;
  let shellEnvSection: TomlSection | null = null;

  const kept: TomlSection[] = [];
  for (const sec of sections) {
    if (sec.header && /^\s*\[mcp_servers\.cograph\]\s*$/.test(sec.header)) {
      if (sec.lines.some((l) => /^\s*bearer_token\s*=/.test(l))) {
        removedInlineTokenBlock = true;
      }
      continue;
    }
    if (sec.header && /^\s*\[mcp_servers\.gitnexus\]\s*$/.test(sec.header)) {
      removedLegacy = true;
      continue;
    }
    if (
      sec.header &&
      /^\s*\[shell_environment_policy\.set\]\s*$/.test(sec.header)
    ) {
      shellEnvSection = sec;
    }
    kept.push(sec);
  }

  if (shellEnvSection) {
    // Strip the managed key if it was already there (we rewrite with the
    // current token value), then append it at the end of this section.
    shellEnvSection.lines = shellEnvSection.lines.filter((line) => {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
      return !(m && m[1] === envVarName);
    });
    while (
      shellEnvSection.lines.length > 0 &&
      shellEnvSection.lines[shellEnvSection.lines.length - 1] === ""
    ) {
      shellEnvSection.lines.pop();
    }
    shellEnvSection.lines.push(managedTokenLine);
  } else {
    kept.push({
      header: shellEnvHeader,
      lines: [managedTokenLine],
    });
  }

  kept.push({
    header: cographHeader,
    lines: [
      `url = ${JSON.stringify(profile.url)}`,
      `bearer_token_env_var = ${JSON.stringify(envVarName)}`,
    ],
  });

  return {
    content: emitTomlSections(kept),
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
