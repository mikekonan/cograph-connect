import fs from "node:fs/promises";
import path from "node:path";

import { AgentClient, clientConfigPath } from "./paths.js";

export type ClientWriteResult = {
  client: AgentClient;
  path: string;
  changed: boolean;
  backupPath?: string;
};

export const MCP_SERVER_NAME = "cograph";

export function mcpServerConfig(profile = "default"): Record<string, unknown> {
  return {
    command: "npx",
    args: ["-y", "cograph-connect", "mcp", "--profile", profile],
  };
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

export function mergeJsonMcpConfig(raw: string | null, profile: string): string {
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
  record.mcpServers = {
    ...existingServers,
    [MCP_SERVER_NAME]: mcpServerConfig(profile),
  };
  return `${JSON.stringify(record, null, 2)}\n`;
}

export function mergeCodexTomlConfig(raw: string | null, profile: string): string {
  const lines = (raw ?? "").split(/\r?\n/);
  const output: string[] = [];
  let skipping = false;
  for (const line of lines) {
    if (/^\s*\[mcp_servers\.cograph\]\s*$/.test(line)) {
      skipping = true;
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
  const block = [
    "[mcp_servers.cograph]",
    'command = "npx"',
    `args = ["-y", "cograph-connect", "mcp", "--profile", ${JSON.stringify(profile)}]`,
  ];
  return `${output.length ? `${output.join("\n")}\n\n` : ""}${block.join("\n")}\n`;
}

export async function configureClient(
  client: AgentClient,
  profile: string,
  filePath = clientConfigPath(client),
): Promise<ClientWriteResult> {
  const raw = await readTextIfExists(filePath);
  const next =
    client === "codex"
      ? mergeCodexTomlConfig(raw, profile)
      : mergeJsonMcpConfig(raw, profile);
  if (raw === next) {
    return { client, path: filePath, changed: false };
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const backupPath = await backupIfExists(filePath);
  await fs.writeFile(filePath, next, "utf8");
  return { client, path: filePath, changed: true, backupPath };
}

export function manualSnippet(client: AgentClient, profile = "default"): string {
  if (client === "codex") {
    return mergeCodexTomlConfig("", profile).trimEnd();
  }
  return JSON.stringify(
    { mcpServers: { [MCP_SERVER_NAME]: mcpServerConfig(profile) } },
    null,
    2,
  );
}
