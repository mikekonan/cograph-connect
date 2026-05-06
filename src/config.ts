import fs from "node:fs/promises";
import path from "node:path";

import { configPath } from "./paths.js";

export type Profile = {
  url: string;
  token: string;
  createdAt: string;
  updatedAt: string;
};

export type AppConfig = {
  version: 1;
  defaultProfile: string;
  profiles: Record<string, Profile>;
};

export function normalizeMcpUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("Cograph URL is required");
  }
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `http://${trimmed}`;
  const url = new URL(withScheme);
  if (url.pathname === "/" || url.pathname === "") {
    url.pathname = "/mcp/";
  } else if (url.pathname.endsWith("/mcp")) {
    url.pathname = `${url.pathname}/`;
  } else if (!url.pathname.endsWith("/mcp/")) {
    url.pathname = path.posix.join(url.pathname, "mcp/");
    if (!url.pathname.endsWith("/")) {
      url.pathname = `${url.pathname}/`;
    }
  }
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function redactToken(token: string): string {
  if (!token) return "";
  if (token.length <= 16) return `${token.slice(0, 4)}…`;
  return `${token.slice(0, 12)}…${token.slice(-6)}`;
}

export async function readConfig(filePath = configPath()): Promise<AppConfig | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as AppConfig;
    if (!parsed || parsed.version !== 1 || typeof parsed.defaultProfile !== "string") {
      throw new Error("Unsupported cograph-connect config format");
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function writeConfig(
  config: AppConfig,
  filePath = configPath(),
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const body = `${JSON.stringify(config, null, 2)}\n`;
  await fs.writeFile(filePath, body, { mode: 0o600 });
  if (process.platform !== "win32") {
    await fs.chmod(path.dirname(filePath), 0o700).catch(() => undefined);
    await fs.chmod(filePath, 0o600).catch(() => undefined);
  }
}

export async function upsertProfile({
  profileName,
  url,
  token,
  filePath = configPath(),
}: {
  profileName: string;
  url: string;
  token: string;
  filePath?: string;
}): Promise<AppConfig> {
  const existing = await readConfig(filePath);
  const now = new Date().toISOString();
  const config: AppConfig =
    existing ?? { version: 1, defaultProfile: profileName, profiles: {} };
  const previous = config.profiles[profileName];
  config.defaultProfile = profileName;
  config.profiles[profileName] = {
    url: normalizeMcpUrl(url),
    token,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  };
  await writeConfig(config, filePath);
  return config;
}

export function publicConfig(config: AppConfig): unknown {
  return {
    version: config.version,
    defaultProfile: config.defaultProfile,
    profiles: Object.fromEntries(
      Object.entries(config.profiles).map(([name, profile]) => [
        name,
        {
          url: profile.url,
          token: redactToken(profile.token),
          createdAt: profile.createdAt,
          updatedAt: profile.updatedAt,
        },
      ]),
    ),
  };
}

export async function requireProfile(profileName?: string): Promise<Profile> {
  const config = await readConfig();
  if (!config) {
    throw new Error("cograph-connect is not configured. Run `cograph-connect setup`.");
  }
  const name = profileName || config.defaultProfile;
  const profile = config.profiles[name];
  if (!profile) {
    throw new Error(`Profile not found: ${name}`);
  }
  return {
    ...profile,
    token: process.env.COGRAPH_CONNECT_TOKEN || profile.token,
  };
}
