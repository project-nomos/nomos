import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { LoadedPlugin, PluginManifest, InstalledManifest, SdkPluginConfig } from "./types.ts";

const PLUGINS_DIR = join(homedir(), ".nomos", "plugins");
const MANIFEST_PATH = join(PLUGINS_DIR, "installed.json");

export async function readInstalledManifest(): Promise<InstalledManifest> {
  if (!existsSync(MANIFEST_PATH)) {
    return { version: 1, plugins: [] };
  }
  try {
    const raw = await readFile(MANIFEST_PATH, "utf-8");
    return JSON.parse(raw) as InstalledManifest;
  } catch {
    return { version: 1, plugins: [] };
  }
}

async function readPluginManifest(pluginDir: string): Promise<PluginManifest | null> {
  const manifestPath = join(pluginDir, ".claude-plugin", "plugin.json");
  if (!existsSync(manifestPath)) return null;
  try {
    const raw = await readFile(manifestPath, "utf-8");
    return JSON.parse(raw) as PluginManifest;
  } catch {
    return null;
  }
}

export async function loadInstalledPlugins(): Promise<LoadedPlugin[]> {
  const manifest = await readInstalledManifest();
  const plugins: LoadedPlugin[] = [];

  for (const entry of manifest.plugins) {
    const pluginDir = join(PLUGINS_DIR, entry.name);
    if (!existsSync(pluginDir)) continue;

    const meta = await readPluginManifest(pluginDir);
    if (!meta) continue;

    plugins.push({
      name: meta.name,
      description: meta.description,
      path: pluginDir,
      marketplace: entry.marketplace,
      sdkConfig: { type: "local", path: pluginDir },
    });
  }

  return plugins;
}

export function toSdkPluginConfigs(plugins: LoadedPlugin[]): SdkPluginConfig[] {
  return plugins.map((p) => p.sdkConfig);
}
