import fs from "node:fs/promises";
import path from "node:path";

import { codexSkillPath } from "./paths.js";

export async function installCodexSkill({
  packageRoot,
  target = codexSkillPath(),
}: {
  packageRoot: string;
  target?: string;
}): Promise<string> {
  const source = path.join(packageRoot, "templates", "codex-skill");
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.rm(target, { recursive: true, force: true });
  await fs.cp(source, target, { recursive: true });
  return target;
}
