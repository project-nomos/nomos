import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const dynamic = "force-dynamic";

interface SkillInfo {
  name: string;
  description: string;
  source: string;
  emoji?: string;
  filePath: string;
}

interface PluginInfo {
  name: string;
  description: string;
  marketplace: string;
  source: string;
  version: string;
  installedAt: string;
}

function loadSkillsFromDir(dir: string, source: string): SkillInfo[] {
  if (!fs.existsSync(dir)) return [];
  const skills: SkillInfo[] = [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const skillMd = path.join(dir, entry.name, "SKILL.md");
    if (!fs.existsSync(skillMd)) continue;

    try {
      const raw = fs.readFileSync(skillMd, "utf-8");
      const fm = parseFrontmatter(raw);
      skills.push({
        name: fm.name ?? entry.name,
        description: fm.description ?? "",
        source,
        emoji: fm.emoji,
        filePath: skillMd,
      });
    } catch {
      // skip malformed
    }
  }
  return skills;
}

function parseFrontmatter(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!raw.startsWith("---")) return result;
  const end = raw.indexOf("---", 3);
  if (end < 0) return result;
  const block = raw.slice(3, end).trim();
  for (const line of block.split("\n")) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    // strip quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    result[key] = val;
  }
  return result;
}

function loadPlugins(): PluginInfo[] {
  const manifestPath = path.join(os.homedir(), ".nomos", "plugins", "installed.json");
  if (!fs.existsSync(manifestPath)) return [];

  try {
    const raw = fs.readFileSync(manifestPath, "utf-8");
    const manifest = JSON.parse(raw);
    const plugins: PluginInfo[] = [];

    for (const entry of manifest.plugins ?? []) {
      // Read the plugin's own manifest for description
      const pluginDir = path.join(os.homedir(), ".nomos", "plugins", entry.name);
      const pluginJson = path.join(pluginDir, ".claude-plugin", "plugin.json");
      let description = "";
      if (fs.existsSync(pluginJson)) {
        try {
          const meta = JSON.parse(fs.readFileSync(pluginJson, "utf-8"));
          description = meta.description ?? "";
        } catch {
          // skip
        }
      }

      plugins.push({
        name: entry.name,
        description,
        marketplace: entry.marketplace ?? "unknown",
        source: entry.source ?? "plugins",
        version: entry.version ?? "unknown",
        installedAt: entry.installedAt ?? "",
      });
    }

    return plugins.sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

export async function GET() {
  try {
    // Load skills from all tiers
    // Settings app runs from settings/ subdir -- resolve repo root
    const cwd = process.cwd();
    const repoRoot = cwd.endsWith("/settings") ? path.dirname(cwd) : cwd;
    const bundledDir = path.join(repoRoot, "skills");
    const personalDir = path.join(os.homedir(), ".nomos", "skills");
    const projectDirs = [bundledDir, path.join(repoRoot, ".nomos", "skills")];

    const merged = new Map<string, SkillInfo>();

    // Bundled skills (check if the resolved dir actually has skills)
    for (const skill of loadSkillsFromDir(bundledDir, "bundled")) {
      merged.set(skill.name, skill);
    }
    for (const skill of loadSkillsFromDir(personalDir, "personal")) {
      merged.set(skill.name, skill);
    }
    for (const dir of projectDirs) {
      for (const skill of loadSkillsFromDir(dir, "project")) {
        merged.set(skill.name, skill);
      }
    }

    const skills = Array.from(merged.values()).sort((a, b) => a.name.localeCompare(b.name));
    const plugins = loadPlugins();

    return NextResponse.json({ skills, plugins });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: `Failed to load extensions: ${message}` }, { status: 500 });
  }
}
