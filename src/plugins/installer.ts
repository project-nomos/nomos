import { existsSync } from "node:fs";
import { readdir, readFile, cp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type {
  AvailablePlugin,
  InstalledManifest,
  InstalledPluginEntry,
  PluginManifest,
} from "./types.ts";
import { DEFAULT_PLUGINS } from "./types.ts";
import { readInstalledManifest } from "./loader.ts";

const PLUGINS_DIR = join(homedir(), ".nomos", "plugins");
const MANIFEST_PATH = join(PLUGINS_DIR, "installed.json");
const MARKETPLACE_BASE = join(homedir(), ".claude", "plugins", "marketplaces");
const KNOWN_MARKETPLACES_PATH = join(homedir(), ".claude", "plugins", "known_marketplaces.json");

interface KnownMarketplaces {
  [name: string]: {
    source: { source: string; repo: string };
    installLocation: string;
    lastUpdated: string;
  };
}

async function loadKnownMarketplaces(): Promise<KnownMarketplaces> {
  if (!existsSync(KNOWN_MARKETPLACES_PATH)) return {};
  try {
    const raw = await readFile(KNOWN_MARKETPLACES_PATH, "utf-8");
    return JSON.parse(raw) as KnownMarketplaces;
  } catch {
    return {};
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

async function writeManifest(manifest: InstalledManifest): Promise<void> {
  await mkdir(PLUGINS_DIR, { recursive: true });
  await writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n");
}

async function scanMarketplaceDir(
  baseDir: string,
  subdir: "plugins" | "external_plugins",
  marketplaceName: string,
  installedNames: Set<string>,
): Promise<AvailablePlugin[]> {
  const dir = join(baseDir, subdir);
  if (!existsSync(dir)) return [];

  const results: AvailablePlugin[] = [];
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  for (const name of entries) {
    if (name.startsWith(".")) continue;
    const pluginDir = join(dir, name);
    const meta = await readPluginManifest(pluginDir);
    if (!meta) continue;

    results.push({
      name: meta.name,
      description: meta.description,
      author: meta.author?.name,
      source: subdir,
      marketplace: marketplaceName,
      installed: installedNames.has(meta.name),
    });
  }

  return results;
}

export async function listAvailablePlugins(): Promise<AvailablePlugin[]> {
  const marketplaces = await loadKnownMarketplaces();
  const manifest = await readInstalledManifest();
  const installedNames = new Set(manifest.plugins.map((p) => p.name));

  const all: AvailablePlugin[] = [];

  for (const [name, config] of Object.entries(marketplaces)) {
    const baseDir = config.installLocation;
    if (!existsSync(baseDir)) continue;

    const [plugins, external] = await Promise.all([
      scanMarketplaceDir(baseDir, "plugins", name, installedNames),
      scanMarketplaceDir(baseDir, "external_plugins", name, installedNames),
    ]);
    all.push(...plugins, ...external);
  }

  return all.sort((a, b) => a.name.localeCompare(b.name));
}

async function resolvePluginInMarketplace(
  name: string,
  marketplace?: string,
): Promise<{
  dirPath: string;
  source: "plugins" | "external_plugins";
  marketplace: string;
} | null> {
  const marketplaces = await loadKnownMarketplaces();
  const entries = marketplace
    ? [[marketplace, marketplaces[marketplace]] as const].filter(([, v]) => v)
    : Object.entries(marketplaces);

  for (const [mktName, config] of entries) {
    if (!config) continue;
    const baseDir = config.installLocation;
    if (!existsSync(baseDir)) continue;

    for (const subdir of ["plugins", "external_plugins"] as const) {
      const pluginDir = join(baseDir, subdir, name);
      if (existsSync(join(pluginDir, ".claude-plugin", "plugin.json"))) {
        return { dirPath: pluginDir, source: subdir, marketplace: mktName as string };
      }
    }
  }

  return null;
}

export async function installPlugin(
  name: string,
  marketplace?: string,
): Promise<InstalledPluginEntry> {
  const resolved = await resolvePluginInMarketplace(name, marketplace);
  if (!resolved) {
    throw new Error(
      `Plugin "${name}" not found in ${marketplace ? `marketplace "${marketplace}"` : "any marketplace"}`,
    );
  }

  const destDir = join(PLUGINS_DIR, name);
  await mkdir(PLUGINS_DIR, { recursive: true });

  // Remove existing install (update case)
  if (existsSync(destDir)) {
    await rm(destDir, { recursive: true, force: true });
  }

  await cp(resolved.dirPath, destDir, { recursive: true });

  const meta = await readPluginManifest(destDir);
  const entry: InstalledPluginEntry = {
    name,
    version: meta?.version ?? "unknown",
    marketplace: resolved.marketplace,
    source: resolved.source,
    installedAt: new Date().toISOString(),
  };

  // Update manifest
  const manifest = await readInstalledManifest();
  const idx = manifest.plugins.findIndex((p) => p.name === name);
  if (idx >= 0) {
    manifest.plugins[idx] = entry;
  } else {
    manifest.plugins.push(entry);
  }
  await writeManifest(manifest);

  return entry;
}

export async function removePlugin(name: string): Promise<void> {
  const destDir = join(PLUGINS_DIR, name);
  if (existsSync(destDir)) {
    await rm(destDir, { recursive: true, force: true });
  }

  const manifest = await readInstalledManifest();
  manifest.plugins = manifest.plugins.filter((p) => p.name !== name);
  await writeManifest(manifest);
}

export async function ensureDefaultPlugins(): Promise<string[]> {
  const marketplaces = await loadKnownMarketplaces();
  if (Object.keys(marketplaces).length === 0) return [];

  const manifest = await readInstalledManifest();
  const installedNames = new Set(manifest.plugins.map((p) => p.name));

  const newlyInstalled: string[] = [];
  for (const plugin of DEFAULT_PLUGINS) {
    if (installedNames.has(plugin.name)) continue;

    try {
      await installPlugin(plugin.name, "claude-plugins-official");
      newlyInstalled.push(plugin.name);
    } catch {
      // Marketplace may not have this plugin — skip silently
    }
  }

  return newlyInstalled;
}

export async function getPluginInfo(name: string): Promise<AvailablePlugin | null> {
  const marketplaces = await loadKnownMarketplaces();
  const manifest = await readInstalledManifest();
  const installedNames = new Set(manifest.plugins.map((p) => p.name));

  for (const [mktName, config] of Object.entries(marketplaces)) {
    const baseDir = config.installLocation;
    if (!existsSync(baseDir)) continue;

    for (const subdir of ["plugins", "external_plugins"] as const) {
      const pluginDir = join(baseDir, subdir, name);
      const meta = await readPluginManifest(pluginDir);
      if (!meta) continue;

      return {
        name: meta.name,
        description: meta.description,
        author: meta.author?.name,
        source: subdir,
        marketplace: mktName,
        installed: installedNames.has(meta.name),
      };
    }
  }

  return null;
}
