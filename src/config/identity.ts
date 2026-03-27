import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentIdentity } from "./profile.ts";

/**
 * Load IDENTITY.md from filesystem and parse it into AgentIdentity fields.
 * Search locations (first found wins):
 * 1. ./.nomos/IDENTITY.md (project-local)
 * 2. ~/.nomos/IDENTITY.md (global)
 *
 * Format (YAML-like frontmatter):
 *   name: Nomos
 *   emoji: 🔮
 *   purpose: Personal AI agent for software engineering
 *
 * @returns Partial identity fields or null if not found
 */
export function loadIdentityFile(): Partial<AgentIdentity> | null {
  const searchPaths = [
    path.resolve(".nomos", "IDENTITY.md"),
    path.join(os.homedir(), ".nomos", "IDENTITY.md"),
  ];

  for (const filePath of searchPaths) {
    if (fs.existsSync(filePath)) {
      try {
        const content = fs.readFileSync(filePath, "utf-8");
        return parseIdentity(content);
      } catch {
        continue;
      }
    }
  }

  return null;
}

function parseIdentity(content: string): Partial<AgentIdentity> | null {
  const identity: Partial<AgentIdentity> = {};

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    // Skip comments and headings
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//")) continue;

    const match = trimmed.match(/^(\w+)\s*:\s*(.+)$/);
    if (!match) continue;

    const [, key, value] = match;
    const val = value!.trim();

    switch (key!.toLowerCase()) {
      case "name":
        identity.name = val;
        break;
      case "emoji":
        identity.emoji = val;
        break;
      case "purpose":
        identity.purpose = val;
        break;
    }
  }

  return Object.keys(identity).length > 0 ? identity : null;
}
