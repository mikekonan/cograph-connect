import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  normalizeMcpUrl,
  publicConfig,
  readConfig,
  upsertProfile,
  type Profile,
} from "../src/config.js";
import {
  mergeCodexTomlConfig,
  mergeJsonMcpConfig,
} from "../src/client-config.js";
import { clientConfigPath, clientSkillPath } from "../src/paths.js";

const profileFor = (url: string, token: string): Profile => ({
  url: normalizeMcpUrl(url),
  token,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const DEFAULT_PROFILE = profileFor(
  "https://cograph.example.com",
  "cgr_pat_abc123",
);

describe("config", () => {
  test("normalizes base and MCP URLs to /mcp/", () => {
    expect(normalizeMcpUrl("localhost:8080")).toBe("http://localhost:8080/mcp/");
    expect(normalizeMcpUrl("https://cograph.example.com")).toBe(
      "https://cograph.example.com/mcp/",
    );
    expect(normalizeMcpUrl("https://cograph.example.com/mcp")).toBe(
      "https://cograph.example.com/mcp/",
    );
  });

  test("writes config with redacted public view", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cograph-connect-"));
    const file = path.join(dir, "config.json");
    const config = await upsertProfile({
      profileName: "default",
      url: "http://localhost:8080",
      token: "cgr_pat_abcdefghijklmnopqrstuvwxyz0123456789",
      filePath: file,
    });

    expect((await readConfig(file))?.profiles.default.url).toBe(
      "http://localhost:8080/mcp/",
    );
    expect(JSON.stringify(publicConfig(config))).not.toContain(
      "abcdefghijklmnopqrstuvwxyz",
    );
    if (process.platform !== "win32") {
      const mode = (await fs.stat(file)).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });
});

describe("client config — Claude Code (direct HTTP)", () => {
  test("writes type:http entry with inline Bearer header", () => {
    const merged = JSON.parse(
      mergeJsonMcpConfig(null, "claude-code", "default", DEFAULT_PROFILE).content,
    );
    expect(merged.mcpServers.cograph).toEqual({
      type: "http",
      url: "https://cograph.example.com/mcp/",
      headers: { Authorization: "Bearer cgr_pat_abc123" },
    });
  });

  test("preserves other mcpServers entries", () => {
    const merged = JSON.parse(
      mergeJsonMcpConfig(
        JSON.stringify({ mcpServers: { other: { command: "node" } } }),
        "claude-code",
        "default",
        DEFAULT_PROFILE,
      ).content,
    );
    expect(merged.mcpServers.other.command).toBe("node");
    expect(merged.mcpServers.cograph.type).toBe("http");
  });

  test("never writes npx for claude-code", () => {
    const content = mergeJsonMcpConfig(
      null,
      "claude-code",
      "default",
      DEFAULT_PROFILE,
    ).content;
    expect(content).not.toContain("npx");
  });
});

describe("client config — Claude Code per-project propagation", () => {
  // Claude Code stores per-project MCP server lists under
  // `projects.<path>.mcpServers`. Critically, that block REPLACES the
  // top-level mcpServers (not merges with it). So a directory with even
  // one other per-project server (archon, codex-cli, etc.) will silently
  // miss the top-level cograph unless we propagate it down.

  test("writes fresh cograph entry into every existing per-project mcpServers", () => {
    const result = mergeJsonMcpConfig(
      JSON.stringify({
        mcpServers: {},
        projects: {
          "/Users/me/work/repo-a": {
            mcpServers: { archon: { command: "archon", args: ["mcp"] } },
          },
          "/Users/me/work/repo-b": {
            mcpServers: { "codex-cli": { command: "codex", args: ["mcp-server"] } },
          },
        },
      }),
      "claude-code",
      "default",
      DEFAULT_PROFILE,
    );
    const merged = JSON.parse(result.content);
    expect(merged.projects["/Users/me/work/repo-a"].mcpServers.cograph).toEqual({
      type: "http",
      url: "https://cograph.example.com/mcp/",
      headers: { Authorization: "Bearer cgr_pat_abc123" },
    });
    expect(merged.projects["/Users/me/work/repo-a"].mcpServers.archon).toBeDefined();
    expect(merged.projects["/Users/me/work/repo-b"].mcpServers.cograph).toEqual({
      type: "http",
      url: "https://cograph.example.com/mcp/",
      headers: { Authorization: "Bearer cgr_pat_abc123" },
    });
    expect(merged.projects["/Users/me/work/repo-b"].mcpServers["codex-cli"]).toBeDefined();
  });

  test("replaces a stale per-project cograph entry with the fresh top-level token", () => {
    // Reproducer for the actual user-hit bug: setup ran once with token A,
    // a manual backfill propagated token A into 50 per-project blocks; setup
    // ran again with token B (PAT re-issued); top-level got token B but the
    // 50 per-project blocks were left at token A → 401s in those dirs.
    const result = mergeJsonMcpConfig(
      JSON.stringify({
        mcpServers: {
          cograph: {
            type: "http",
            url: "https://cograph.example.com/mcp/",
            headers: { Authorization: "Bearer cgr_pat_TOKEN_A" },
          },
        },
        projects: {
          "/Users/me/work/repo-a": {
            mcpServers: {
              archon: { command: "archon", args: ["mcp"] },
              cograph: {
                type: "http",
                url: "https://cograph.example.com/mcp/",
                headers: { Authorization: "Bearer cgr_pat_STALE" },
              },
            },
          },
        },
      }),
      "claude-code",
      "default",
      DEFAULT_PROFILE,
    );
    const merged = JSON.parse(result.content);
    // Top-level got the fresh token (cgr_pat_abc123 from DEFAULT_PROFILE)
    expect(merged.mcpServers.cograph.headers.Authorization).toBe(
      "Bearer cgr_pat_abc123",
    );
    // Per-project block also got the same fresh token — this is the bug fix
    expect(
      merged.projects["/Users/me/work/repo-a"].mcpServers.cograph.headers.Authorization,
    ).toBe("Bearer cgr_pat_abc123");
    // The other per-project server is untouched
    expect(merged.projects["/Users/me/work/repo-a"].mcpServers.archon).toBeDefined();
  });

  test("leaves projects WITHOUT per-project mcpServers untouched (they inherit top-level)", () => {
    const result = mergeJsonMcpConfig(
      JSON.stringify({
        projects: {
          "/Users/me/work/inherits-global": {
            history: [{ display: "previous prompt" }],
          },
        },
      }),
      "claude-code",
      "default",
      DEFAULT_PROFILE,
    );
    const merged = JSON.parse(result.content);
    // Did NOT inject an mcpServers block where there wasn't one — those
    // projects correctly inherit the top-level entry by Claude Code semantics.
    expect(
      merged.projects["/Users/me/work/inherits-global"].mcpServers,
    ).toBeUndefined();
    // Top-level was still written.
    expect(merged.mcpServers.cograph).toBeDefined();
    // Other per-project data (history) preserved.
    expect(
      merged.projects["/Users/me/work/inherits-global"].history,
    ).toHaveLength(1);
  });

  test("legacy gitnexus in a per-project mcpServers triggers removedLegacy", () => {
    const result = mergeJsonMcpConfig(
      JSON.stringify({
        projects: {
          "/Users/me/work/legacy-repo": {
            mcpServers: { gitnexus: { command: "gitnexus", args: ["mcp"] } },
          },
        },
      }),
      "claude-code",
      "default",
      DEFAULT_PROFILE,
    );
    const merged = JSON.parse(result.content);
    expect(
      merged.projects["/Users/me/work/legacy-repo"].mcpServers.gitnexus,
    ).toBeUndefined();
    expect(
      merged.projects["/Users/me/work/legacy-repo"].mcpServers.cograph,
    ).toBeDefined();
    expect(result.removedLegacy).toBe(true);
  });

  test("does NOT propagate per-project for cursor or claude (Desktop)", () => {
    // Cursor and Claude Desktop have flat config files; their per-project
    // story (if any) is different. cograph-connect only manages the
    // top-level mcpServers for those clients.
    const cursorResult = mergeJsonMcpConfig(
      JSON.stringify({
        projects: { "/foo": { mcpServers: { other: { command: "x" } } } },
      }),
      "cursor",
      "default",
      DEFAULT_PROFILE,
    );
    const merged = JSON.parse(cursorResult.content);
    // Cursor block should NOT have injected cograph into projects.foo.mcpServers
    expect(merged.projects["/foo"].mcpServers.cograph).toBeUndefined();
    expect(merged.mcpServers.cograph).toBeDefined();
  });
});

describe("client config — Cursor (direct HTTP, no type field)", () => {
  test("writes url+headers without type discriminator", () => {
    const merged = JSON.parse(
      mergeJsonMcpConfig(null, "cursor", "default", DEFAULT_PROFILE).content,
    );
    expect(merged.mcpServers.cograph).toEqual({
      url: "https://cograph.example.com/mcp/",
      headers: { Authorization: "Bearer cgr_pat_abc123" },
    });
    expect(merged.mcpServers.cograph.type).toBeUndefined();
  });
});

describe("client config — Claude Desktop (mcp-remote stdio bridge)", () => {
  test("writes mcp-remote command — its config validator only accepts stdio", () => {
    const merged = JSON.parse(
      mergeJsonMcpConfig(null, "claude", "default", DEFAULT_PROFILE).content,
    );
    const entry = merged.mcpServers.cograph;
    expect(entry.command).toBe("npx");
    expect(entry.args).toEqual([
      "-y",
      "mcp-remote",
      "https://cograph.example.com/mcp/",
      "--header",
      "Authorization: Bearer cgr_pat_abc123",
    ]);
    expect(entry.env).toEqual({ NODE_OPTIONS: "--use-system-ca" });
  });

  test("rewriting an existing npx bridge entry is NOT flagged as legacy", () => {
    // Claude Desktop legitimately uses the bridge today — finding npx in the
    // existing config is normal state, not a migration signal. The user would
    // see "removed legacy npx bridge" on every setup otherwise.
    const result = mergeJsonMcpConfig(
      JSON.stringify({
        mcpServers: {
          cograph: {
            command: "npx",
            args: [
              "-y",
              "mcp-remote",
              "https://cograph.example.com/mcp/",
              "--header",
              "Authorization: Bearer old_token",
            ],
            env: { NODE_OPTIONS: "--use-system-ca" },
          },
        },
      }),
      "claude",
      "default",
      DEFAULT_PROFILE,
    );
    expect(result.removedNpxBridge).toBe(false);
  });
});

describe("Claude Code legacy cleanup (npx bridge → direct HTTP)", () => {
  test("active cleanup: npx/mcp-remote entry in claude-code is replaced and flagged", () => {
    // Claude Code DOES support direct HTTP; an npx-shaped entry there is
    // genuine legacy from older cograph-connect versions.
    const result = mergeJsonMcpConfig(
      JSON.stringify({
        mcpServers: {
          cograph: {
            command: "npx",
            args: [
              "-y",
              "mcp-remote",
              "https://old.example.com/mcp/",
              "--header",
              "Authorization: Bearer old_token",
            ],
          },
        },
      }),
      "claude-code",
      "default",
      DEFAULT_PROFILE,
    );
    const merged = JSON.parse(result.content);
    expect(merged.mcpServers.cograph.type).toBe("http");
    expect(merged.mcpServers.cograph.command).toBeUndefined();
    expect(result.removedNpxBridge).toBe(true);
  });

  test("does NOT flag npx cleanup for an already-direct-HTTP claude-code entry", () => {
    const result = mergeJsonMcpConfig(
      JSON.stringify({
        mcpServers: {
          cograph: {
            type: "http",
            url: "https://old.example.com/mcp/",
            headers: { Authorization: "Bearer prev" },
          },
        },
      }),
      "claude-code",
      "default",
      DEFAULT_PROFILE,
    );
    expect(result.removedNpxBridge).toBe(false);
  });
});

describe("client config — Codex (TOML, env-var auth + shell_environment_policy.set)", () => {
  test("writes bearer_token_env_var in mcp_servers block AND token in shell_environment_policy.set", () => {
    // Codex's MCP client parses `bearer_token = "..."` but never applies it
    // as an Authorization header — sessions 401 silently. The only token-
    // binding form Codex honours is `bearer_token_env_var = "<NAME>"`, and
    // Codex resolves <NAME> from its own [shell_environment_policy.set]
    // block (so we don't need ~/.zshrc or launchctl).
    const result = mergeCodexTomlConfig(null, "default", DEFAULT_PROFILE);
    expect(result.content).toContain("[mcp_servers.cograph]");
    expect(result.content).toContain(
      'url = "https://cograph.example.com/mcp/"',
    );
    expect(result.content).toContain('bearer_token_env_var = "COGRAPH_TOKEN"');
    expect(result.content).toContain("[shell_environment_policy.set]");
    expect(result.content).toContain('COGRAPH_TOKEN = "cgr_pat_abc123"');
    // Critical: must NOT write inline bearer_token = "..." in mcp_servers
    // block (that's the 0.6.0–0.7.0 broken shape Codex silently 401s on).
    expect(result.content).not.toMatch(/^\s*bearer_token\s*=/m);
  });

  test("non-default profile uses a sanitized env var name in both blocks", () => {
    const result = mergeCodexTomlConfig("", "work-prod", DEFAULT_PROFILE);
    expect(result.content).toContain(
      'bearer_token_env_var = "COGRAPH_TOKEN_WORK_PROD"',
    );
    expect(result.content).toContain(
      'COGRAPH_TOKEN_WORK_PROD = "cgr_pat_abc123"',
    );
  });

  test("merges into an existing shell_environment_policy.set, preserving other keys", () => {
    // The user's config may already have unrelated keys (CLAUDE_*, ripgrep
    // toggle, etc.) in shell_environment_policy.set. cograph-connect must
    // preserve them verbatim and only manage the COGRAPH_TOKEN key.
    const result = mergeCodexTomlConfig(
      [
        "[shell_environment_policy.set]",
        'CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR = "1"',
        'USE_BUILTIN_RIPGREP = "1"',
      ].join("\n"),
      "default",
      DEFAULT_PROFILE,
    );
    expect(result.content).toContain(
      'CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR = "1"',
    );
    expect(result.content).toContain('USE_BUILTIN_RIPGREP = "1"');
    expect(result.content).toContain('COGRAPH_TOKEN = "cgr_pat_abc123"');
    // shell_environment_policy.set header appears exactly once — we didn't
    // duplicate it as a new block.
    const headerCount = (
      result.content.match(/^\[shell_environment_policy\.set\]/gm) ?? []
    ).length;
    expect(headerCount).toBe(1);
  });

  test("replaces an out-of-date COGRAPH_TOKEN value in shell_environment_policy.set", () => {
    const result = mergeCodexTomlConfig(
      [
        "[shell_environment_policy.set]",
        'CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR = "1"',
        'COGRAPH_TOKEN = "stale_old_value"',
      ].join("\n"),
      "default",
      DEFAULT_PROFILE,
    );
    expect(result.content).toContain('COGRAPH_TOKEN = "cgr_pat_abc123"');
    expect(result.content).not.toContain("stale_old_value");
    expect(result.content).toContain(
      'CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR = "1"',
    );
  });

  test("active cleanup: legacy inline bearer_token block is replaced and flagged", () => {
    // 0.6.0–0.7.0 cograph-connect inlined the token as `bearer_token = "..."`
    // — Codex parsed it but ignored it. Detect that shape and migrate to
    // `bearer_token_env_var`, surfacing the cleanup via removedNpxBridge so
    // the CLI announces it in the same channel as other legacy cleanups.
    const result = mergeCodexTomlConfig(
      [
        "[mcp_servers.cograph]",
        'url = "https://old.example.com/mcp/"',
        'bearer_token = "old_token"',
      ].join("\n"),
      "default",
      DEFAULT_PROFILE,
    );
    expect(result.content).toContain('bearer_token_env_var = "COGRAPH_TOKEN"');
    expect(result.content).not.toContain('bearer_token = "old_token"');
    expect(result.removedNpxBridge).toBe(true);
  });

  test("does NOT flag cleanup for an already-env-var block", () => {
    // Idempotent rewrite — the existing block already has the good shape,
    // nothing to migrate.
    const result = mergeCodexTomlConfig(
      [
        "[mcp_servers.cograph]",
        'url = "https://old.example.com/mcp/"',
        'bearer_token_env_var = "COGRAPH_TOKEN"',
      ].join("\n"),
      "default",
      DEFAULT_PROFILE,
    );
    expect(result.removedNpxBridge).toBe(false);
  });

  test("preserves unrelated TOML blocks", () => {
    const result = mergeCodexTomlConfig(
      [
        'model = "gpt-5"',
        "",
        "[mcp_servers.other]",
        'command = "node"',
      ].join("\n"),
      "default",
      DEFAULT_PROFILE,
    );
    expect(result.content).toContain('model = "gpt-5"');
    expect(result.content).toContain("[mcp_servers.other]");
  });
});

describe("legacy gitnexus removal still works", () => {
  test("removes legacy gitnexus JSON entry and flags removedLegacy", () => {
    const result = mergeJsonMcpConfig(
      JSON.stringify({
        mcpServers: {
          gitnexus: { command: "gitnexus", args: ["mcp"] },
          other: { command: "node" },
        },
      }),
      "claude-code",
      "default",
      DEFAULT_PROFILE,
    );
    const merged = JSON.parse(result.content);
    expect(merged.mcpServers.gitnexus).toBeUndefined();
    expect(merged.mcpServers.other.command).toBe("node");
    expect(merged.mcpServers.cograph).toBeDefined();
    expect(result.removedLegacy).toBe(true);
  });

  test("legacy gitnexus npx bridge in claude-code triggers both flags", () => {
    // For claude-code the new entry is direct HTTP, so an npx bridge in the
    // old gitnexus slot is genuine legacy.
    const result = mergeJsonMcpConfig(
      JSON.stringify({
        mcpServers: {
          gitnexus: {
            command: "npx",
            args: ["-y", "mcp-remote", "https://old/mcp/"],
          },
        },
      }),
      "claude-code",
      "default",
      DEFAULT_PROFILE,
    );
    expect(result.removedLegacy).toBe(true);
    expect(result.removedNpxBridge).toBe(true);
  });

  test("removes legacy gitnexus TOML block", () => {
    const result = mergeCodexTomlConfig(
      [
        "[mcp_servers.gitnexus]",
        'command = "gitnexus"',
        'args = ["mcp"]',
        "",
        "[mcp_servers.other]",
        'command = "node"',
      ].join("\n"),
      "default",
      DEFAULT_PROFILE,
    );
    expect(result.content).not.toContain("[mcp_servers.gitnexus]");
    expect(result.content).toContain("[mcp_servers.other]");
    expect(result.content).toContain("[mcp_servers.cograph]");
    expect(result.removedLegacy).toBe(true);
  });

  test("replaces existing cograph block instead of duplicating", () => {
    const result = mergeCodexTomlConfig(
      [
        "[mcp_servers.cograph]",
        'command = "old"',
        'args = ["old"]',
        "",
        "[mcp_servers.other]",
        'command = "node"',
      ].join("\n"),
      "work",
      DEFAULT_PROFILE,
    );
    expect(result.content).toContain(
      'bearer_token_env_var = "COGRAPH_TOKEN_WORK"',
    );
    expect(result.content).toContain("[mcp_servers.other]");
    expect(result.content).not.toContain('command = "old"');
  });
});

describe("paths", () => {
  test("claude-code writes to ~/.claude.json", () => {
    expect(clientConfigPath("claude-code")).toBe(
      path.join(os.homedir(), ".claude.json"),
    );
  });

  test("claude (Desktop) and claude-code resolve to different files", () => {
    expect(clientConfigPath("claude")).not.toBe(clientConfigPath("claude-code"));
  });

  test("skill path is set for codex and claude-code, null for the rest", () => {
    expect(clientSkillPath("codex")).toBe(
      path.join(os.homedir(), ".codex", "skills", "cograph-connect"),
    );
    expect(clientSkillPath("claude-code")).toBe(
      path.join(os.homedir(), ".claude", "skills", "cograph-connect"),
    );
    expect(clientSkillPath("claude")).toBeNull();
    expect(clientSkillPath("cursor")).toBeNull();
  });
});

describe("non-object root JSON", () => {
  test("handles array root (e.g. accidental array)", () => {
    const result = mergeJsonMcpConfig(
      "[1,2,3]",
      "claude-code",
      "default",
      DEFAULT_PROFILE,
    );
    const merged = JSON.parse(result.content);
    expect(merged.mcpServers.cograph).toBeDefined();
    expect(result.removedLegacy).toBe(false);
  });
});
