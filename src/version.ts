import fs from "node:fs";
import path from "node:path";

import { packageRoot } from "./paths.js";

/** Version read from the published package.json — single source of truth. */
export const PACKAGE_VERSION: string = (() => {
  try {
    const pkgPath = path.join(packageRoot(import.meta.url), "package.json");
    const raw = fs.readFileSync(pkgPath, "utf8");
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();
