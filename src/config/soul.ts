import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Load SOUL.md personality file from filesystem.
 * Search locations (first found wins):
 * 1. ./.nomos/SOUL.md (project-local)
 * 2. ~/.nomos/SOUL.md (global)
 *
 * @returns File contents or null if not found
 */
export function loadSoulFile(): string | null {
  const searchPaths = [
    path.resolve(".nomos", "SOUL.md"),
    path.join(os.homedir(), ".nomos", "SOUL.md"),
  ];

  for (const filePath of searchPaths) {
    if (fs.existsSync(filePath)) {
      try {
        return fs.readFileSync(filePath, "utf-8");
      } catch {
        // Skip if unreadable
        continue;
      }
    }
  }

  return null;
}
