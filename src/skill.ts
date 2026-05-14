import fs from "node:fs/promises";
import path from "node:path";

import { AgentClient, clientSkillPath } from "./paths.js";

export type SkillInstallResult = {
  client: AgentClient;
  target: string;
};

/**
 * Copy the canonical SKILL.md (templates/codex-skill/) into every selected
 * client's skill directory. Clients without a skill loader (Claude Desktop,
 * Cursor) are silently skipped.
 */
export async function installSkill({
  packageRoot,
  clients,
}: {
  packageRoot: string;
  clients: AgentClient[];
}): Promise<SkillInstallResult[]> {
  const source = path.join(packageRoot, "templates", "codex-skill");
  const installed: SkillInstallResult[] = [];

  for (const client of clients) {
    const target = clientSkillPath(client);
    if (!target) continue;
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.rm(target, { recursive: true, force: true });
    await fs.cp(source, target, { recursive: true });
    installed.push({ client, target });
  }

  return installed;
}
