import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Load TOOLS.md environment config file from filesystem.
 * Search locations (first found wins):
 * 1. ./.nomos/TOOLS.md (project-local)
 * 2. ~/.nomos/TOOLS.md (global)
 *
 * @returns File contents or null if not found
 */
export function loadToolsFile(): string | null {
  const searchPaths = [
    path.resolve(".nomos", "TOOLS.md"),
    path.join(os.homedir(), ".nomos", "TOOLS.md"),
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
