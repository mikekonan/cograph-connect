import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  normalizeMcpUrl,
  publicConfig,
  readConfig,
  upsertProfile,
} from "../src/config.js";
import {
  mergeCodexTomlConfig,
  mergeJsonMcpConfig,
  mcpServerConfig,
  PINNED_PACKAGE_SPEC,
} from "../src/client-config.js";
import { clientConfigPath, clientSkillPath } from "../src/paths.js";

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

describe("client config merge", () => {
  test("merges JSON mcpServers without deleting existing servers", () => {
    const merged = JSON.parse(
      mergeJsonMcpConfig(
        JSON.stringify({ mcpServers: { other: { command: "node" } } }),
        "default",
      ).content,
    );
    expect(merged.mcpServers.other.command).toBe("node");
    expect(merged.mcpServers.cograph).toEqual(mcpServerConfig("default"));
  });

  test("pins the proxy command to the installed package version", () => {
    const cfg = mcpServerConfig("default");
    expect(cfg.args).toContain(PINNED_PACKAGE_SPEC);
    expect(PINNED_PACKAGE_SPEC).toMatch(/^cograph-connect@\d+\.\d+\.\d+/);
  });

  test("uses --yes and -- separator so npm 11 npx parses package spec correctly", () => {
    const args = mcpServerConfig("default").args as string[];
    expect(args[0]).toBe("--yes");
    expect(args[1]).toBe("--");
    expect(args[2]).toBe(PINNED_PACKAGE_SPEC);
    expect(args).not.toContain("-y");
  });

  test("replaces only Codex cograph MCP block", () => {
    const merged = mergeCodexTomlConfig(
      [
        'model = "gpt-5"',
        "",
        "[mcp_servers.cograph]",
        'command = "old"',
        'args = ["old"]',
        "",
        "[mcp_servers.other]",
        'command = "node"',
      ].join("\n"),
      "work",
    );
    expect(merged.content).toContain('model = "gpt-5"');
    expect(merged.content).toContain("[mcp_servers.other]");
    expect(merged.content).toContain('--profile", "work"');
    expect(merged.content).toContain('"--yes", "--",');
    expect(merged.content).not.toContain('command = "old"');
    expect(merged.removedLegacy).toBe(false);
  });

  test("removes legacy gitnexus JSON entry and flags removedLegacy", () => {
    const result = mergeJsonMcpConfig(
      JSON.stringify({
        mcpServers: {
          gitnexus: { command: "gitnexus", args: ["mcp"] },
          other: { command: "node" },
        },
      }),
      "default",
    );
    const merged = JSON.parse(result.content);
    expect(merged.mcpServers.gitnexus).toBeUndefined();
    expect(merged.mcpServers.other.command).toBe("node");
    expect(merged.mcpServers.cograph).toBeDefined();
    expect(result.removedLegacy).toBe(true);
  });

  test("removes legacy gitnexus block in Codex TOML and flags removedLegacy", () => {
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
    );
    expect(result.content).not.toContain("[mcp_servers.gitnexus]");
    expect(result.content).toContain("[mcp_servers.other]");
    expect(result.content).toContain("[mcp_servers.cograph]");
    expect(result.removedLegacy).toBe(true);
  });

  test("handles non-object root JSON (e.g. accidental array)", () => {
    const result = mergeJsonMcpConfig("[1,2,3]", "default");
    const merged = JSON.parse(result.content);
    expect(merged.mcpServers.cograph).toBeDefined();
    expect(result.removedLegacy).toBe(false);
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
