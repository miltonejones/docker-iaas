import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

export interface Config {
  apiUrl: string;
  apiKey: string;
}

function configDir(): string {
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
}

function configPath(): string {
  return path.join(configDir(), 'dockyard', 'config.json');
}

export async function loadConfig(): Promise<Config | undefined> {
  try {
    const raw = await fs.readFile(configPath(), 'utf8');
    const parsed = JSON.parse(raw) as Config;
    if (parsed.apiUrl && parsed.apiKey) return parsed;
  } catch {
    /* file missing or invalid */
  }
  return undefined;
}

export async function saveConfig(config: Config): Promise<void> {
  const p = configPath();
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(config, null, 2), { mode: 0o600 });
}

export function resolveConfig(fileConfig?: Config): Config {
  const envUrl = process.env.DOCKYARD_API_URL;
  const envKey = process.env.DOCKYARD_API_KEY;
  if (envUrl && envKey) return { apiUrl: envUrl, apiKey: envKey };
  if (fileConfig) return fileConfig;
  throw new Error(
    'Not logged in. Run `dockyard login` first, or set DOCKYARD_API_URL and DOCKYARD_API_KEY environment variables.',
  );
}

export async function deleteConfig(): Promise<void> {
  try {
    await fs.unlink(configPath());
  } catch {
    /* file already gone */
  }
}
