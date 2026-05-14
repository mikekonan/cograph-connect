import fs from "node:fs/promises";
import path from "node:path";

import { AgentClient, clientConfigPath } from "./paths.js";
import { PACKAGE_VERSION } from "./version.js";

export type ClientWriteResult = {
  client: AgentClient;
  path: string;
  changed: boolean;
  backupPath?: string;
  removedLegacy?: boolean;
};

export type MergeResult = {
  content: string;
  removedLegacy: boolean;
};

export const MCP_SERVER_NAME = "cograph";
export const LEGACY_MCP_SERVER_NAME = "gitnexus";

/**
 * The npm package spec written into client configs. Pinned at install time so
 * Claude Code / Cursor / Codex always launch the version validated by `setup`,
 * not whatever `npx` resolves at run time.
 */
export const PINNED_PACKAGE_SPEC = `cograph-connect@${PACKAGE_VERSION}`;

export function mcpServerConfig(profile = "default"): Record<string, unknown> {
  return {
    command: "npx",
    args: ["-y", PINNED_PACKAGE_SPEC, "mcp", "--profile", profile],
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

export function mergeJsonMcpConfig(raw: string | null, profile: string): MergeResult {
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
    [MCP_SERVER_NAME]: mcpServerConfig(profile),
  };
  return {
    content: `${JSON.stringify(record, null, 2)}\n`,
    removedLegacy,
  };
}

export function mergeCodexTomlConfig(raw: string | null, profile: string): MergeResult {
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
  const block = [
    "[mcp_servers.cograph]",
    'command = "npx"',
    `args = ["-y", ${JSON.stringify(PINNED_PACKAGE_SPEC)}, "mcp", "--profile", ${JSON.stringify(profile)}]`,
  ];
  return {
    content: `${output.length ? `${output.join("\n")}\n\n` : ""}${block.join("\n")}\n`,
    removedLegacy,
  };
}

export async function configureClient(
  client: AgentClient,
  profile: string,
  filePath = clientConfigPath(client),
): Promise<ClientWriteResult> {
  const raw = await readTextIfExists(filePath);
  const merged =
    client === "codex"
      ? mergeCodexTomlConfig(raw, profile)
      : mergeJsonMcpConfig(raw, profile);
  if (raw === merged.content) {
    return { client, path: filePath, changed: false, removedLegacy: false };
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
  };
}

export function manualSnippet(client: AgentClient, profile = "default"): string {
  if (client === "codex") {
    return mergeCodexTomlConfig("", profile).content.trimEnd();
  }
  return JSON.stringify(
    { mcpServers: { [MCP_SERVER_NAME]: mcpServerConfig(profile) } },
    null,
    2,
  );
}
