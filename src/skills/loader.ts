import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseFrontmatter } from "./frontmatter.ts";
import type { Skill } from "./types.ts";

const MAX_SKILL_FILE_BYTES = 256_000;
const MAX_SKILLS_PROMPT_CHARS = 30_000;

/**
 * Load all skills from multiple source directories.
 * Precedence (highest wins): project > personal > bundled
 */
export function loadSkills(): Skill[] {
  const bundledDir = resolveBundledSkillsDir();
  const personalDir = path.join(os.homedir(), ".nomos", "skills");
  const projectDirs = [path.resolve("skills"), path.resolve(".nomos", "skills")];

  const merged = new Map<string, Skill>();

  // Load in precedence order (lowest first, later overwrites)
  if (bundledDir) {
    for (const skill of loadSkillsFromDir(bundledDir, "bundled")) {
      merged.set(skill.name, skill);
    }
  }
  for (const skill of loadSkillsFromDir(personalDir, "personal")) {
    merged.set(skill.name, skill);
  }
  for (const dir of projectDirs) {
    for (const skill of loadSkillsFromDir(dir, "project")) {
      merged.set(skill.name, skill);
    }
  }

  return Array.from(merged.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export function loadSkillsFromDir(dir: string, source: string): Skill[] {
  if (!fs.existsSync(dir)) return [];

  const skills: Skill[] = [];
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
      const stat = fs.statSync(skillMd);
      if (stat.size > MAX_SKILL_FILE_BYTES) continue;

      const raw = fs.readFileSync(skillMd, "utf-8");
      const { frontmatter, body } = parseFrontmatter(raw);

      // Parse requires and install from JSON strings
      let requires: { bins?: string[]; os?: string[] } | undefined;
      if (frontmatter.requires) {
        try {
          requires = JSON.parse(frontmatter.requires);
        } catch {
          // Invalid JSON, skip
        }
      }

      let install: string[] | undefined;
      if (frontmatter.install) {
        try {
          install = JSON.parse(frontmatter.install);
        } catch {
          // Invalid JSON, skip
        }
      }

      skills.push({
        name: frontmatter.name ?? entry.name,
        description: frontmatter.description ?? "",
        content: body,
        filePath: skillMd,
        source,
        emoji: frontmatter.emoji,
        requires,
        install,
      });
    } catch {
      // Skip malformed skill files
    }
  }

  return skills;
}

function resolveBundledSkillsDir(): string | null {
  const candidates = [
    // Dev: project root skills/
    path.resolve("skills"),
    // Installed: relative to entry point
    path.resolve(path.dirname(process.argv[1] ?? ""), "..", "skills"),
  ];

  for (const dir of candidates) {
    if (!fs.existsSync(dir)) continue;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      const hasSkill = entries.some((e) => {
        if (!e.isDirectory()) return false;
        return fs.existsSync(path.join(dir, e.name, "SKILL.md"));
      });
      if (hasSkill) return dir;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Format skills into a system prompt section.
 * Uses progressive disclosure: only name + description go into the prompt.
 * The agent reads the full SKILL.md on demand when it decides to use a skill.
 */
export function formatSkillsForPrompt(skills: Skill[]): string {
  if (skills.length === 0) return "";

  const warnings: string[] = [];
  const catalog: string[] = [];

  for (const skill of skills) {
    // Check for missing binaries
    if (skill.requires?.bins) {
      const missingBins = skill.requires.bins.filter((bin) => !isOnPath(bin));
      if (missingBins.length > 0) {
        warnings.push(
          `⚠️  Skill "${skill.name}" requires missing binaries: ${missingBins.join(", ")}`,
        );
      }
    }

    const skillName = skill.emoji ? `${skill.emoji} ${skill.name}` : skill.name;
    catalog.push(`- **${skillName}**: ${skill.description} → \`${skill.filePath}\``);
  }

  let result = `## Skills\n\nYou have ${skills.length} skill(s) available. When a user request matches a skill, read the skill's SKILL.md file to get full instructions before proceeding.\n\n`;

  if (warnings.length > 0) {
    result += warnings.join("\n") + "\n\n";
  }

  result += catalog.join("\n");

  return result;
}

/**
 * Check if a binary is available on PATH using which command.
 */
function isOnPath(bin: string): boolean {
  try {
    const { execSync } = require("node:child_process");
    execSync(`which ${bin}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
