import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type AgentClient = "claude" | "claude-code" | "cursor" | "codex";

export function configPath(): string {
  if (process.env.COGRAPH_CONNECT_CONFIG) {
    return path.resolve(process.env.COGRAPH_CONNECT_CONFIG);
  }
  if (process.platform === "win32") {
    const base =
      process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(base, "cograph-connect", "config.json");
  }
  const base =
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "cograph-connect", "config.json");
}

export function clientConfigPath(client: AgentClient): string {
  const home = os.homedir();
  switch (client) {
    case "claude":
      if (process.platform === "darwin") {
        return path.join(
          home,
          "Library",
          "Application Support",
          "Claude",
          "claude_desktop_config.json",
        );
      }
      if (process.platform === "win32") {
        const base =
          process.env.APPDATA || path.join(home, "AppData", "Roaming");
        return path.join(base, "Claude", "claude_desktop_config.json");
      }
      return path.join(home, ".config", "Claude", "claude_desktop_config.json");
    case "claude-code":
      return path.join(home, ".claude.json");
    case "cursor":
      return path.join(home, ".cursor", "mcp.json");
    case "codex":
      return path.join(home, ".codex", "config.toml");
  }
}

/**
 * Skill install path for clients that have a SKILL.md loader.
 * Returns null for clients without one (Claude Desktop, Cursor).
 */
export function clientSkillPath(client: AgentClient): string | null {
  const home = os.homedir();
  switch (client) {
    case "codex":
      return path.join(home, ".codex", "skills", "cograph-connect");
    case "claude-code":
      return path.join(home, ".claude", "skills", "cograph-connect");
    case "claude":
    case "cursor":
      return null;
  }
}

export function packageRoot(metaUrl: string): string {
  return path.resolve(path.dirname(fileURLToPath(metaUrl)), "..");
}
