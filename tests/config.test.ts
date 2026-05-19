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

describe("client config — Codex (TOML with inline token)", () => {
  test("writes bearer_token inline, never env-var", () => {
    const result = mergeCodexTomlConfig(null, "default", DEFAULT_PROFILE);
    expect(result.content).toContain("[mcp_servers.cograph]");
    expect(result.content).toContain(
      'url = "https://cograph.example.com/mcp/"',
    );
    expect(result.content).toContain('bearer_token = "cgr_pat_abc123"');
    expect(result.content).not.toContain("bearer_token_env_var");
    expect(result.content).not.toContain("COGRAPH_TOKEN_");
  });

  test("active cleanup: legacy bearer_token_env_var block is replaced and flagged", () => {
    const result = mergeCodexTomlConfig(
      [
        "[mcp_servers.cograph]",
        'url = "https://old.example.com/mcp/"',
        'bearer_token_env_var = "COGRAPH_TOKEN_DEFAULT"',
      ].join("\n"),
      "default",
      DEFAULT_PROFILE,
    );
    expect(result.content).toContain('bearer_token = "cgr_pat_abc123"');
    expect(result.content).not.toContain("bearer_token_env_var");
    expect(result.removedNpxBridge).toBe(true);
  });

  test("does NOT flag cleanup for an already-inline-token block", () => {
    const result = mergeCodexTomlConfig(
      [
        "[mcp_servers.cograph]",
        'url = "https://old.example.com/mcp/"',
        'bearer_token = "old_token"',
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
    expect(result.content).toContain('bearer_token = "cgr_pat_abc123"');
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
