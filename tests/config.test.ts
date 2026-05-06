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
} from "../src/client-config.js";

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
      ),
    );
    expect(merged.mcpServers.other.command).toBe("node");
    expect(merged.mcpServers.cograph).toEqual(mcpServerConfig("default"));
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
    expect(merged).toContain('model = "gpt-5"');
    expect(merged).toContain("[mcp_servers.other]");
    expect(merged).toContain('--profile", "work"');
    expect(merged).not.toContain('command = "old"');
  });
});
