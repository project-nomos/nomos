import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getConfigValue, setConfigValue } from "../db/config.ts";

/** DB config key holding the heartbeat instructions (source of truth). */
const HEARTBEAT_CONFIG_KEY = "heartbeat.content";

/**
 * Constant returned by the agent to signal "no action needed" on heartbeat check.
 */
export const HEARTBEAT_OK = "HEARTBEAT_OK";

/**
 * Constant returned by autonomous loops to signal "no action needed".
 */
export const AUTONOMOUS_OK = "AUTONOMOUS_OK";

/**
 * Load HEARTBEAT.md file from filesystem.
 * Search locations (first found wins):
 * 1. ./.nomos/HEARTBEAT.md (project-local)
 * 2. ~/.nomos/HEARTBEAT.md (global)
 *
 * @returns File contents or null if not found
 */
export function loadHeartbeatFile(): string | null {
  const searchPaths = [
    path.resolve(".nomos", "HEARTBEAT.md"),
    path.join(os.homedir(), ".nomos", "HEARTBEAT.md"),
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

/**
 * Check if heartbeat content is empty or contains only non-actionable content.
 * @param content - The heartbeat file content
 * @returns true if content is only whitespace, comments, or empty markdown headers
 */
export function isHeartbeatEmpty(content: string): boolean {
  const lines = content.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip empty lines
    if (trimmed === "") continue;

    // Skip comments (HTML-style or markdown <!-- -->)
    if (trimmed.startsWith("<!--") || trimmed.startsWith("//")) continue;

    // Skip markdown headers that are just headers (no content after #)
    if (/^#+\s*$/.test(trimmed)) continue;

    // If we find any non-empty, non-comment, non-empty-header line, it's not empty
    return false;
  }

  return true;
}

/**
 * Strip the HEARTBEAT_OK token from response text if present.
 * @param text - The assistant's response text
 * @returns null if response is just HEARTBEAT_OK (suppress), otherwise the original text
 */
export function stripHeartbeatToken(text: string): string | null {
  const trimmed = text.trim();

  const tokens = [HEARTBEAT_OK, AUTONOMOUS_OK];

  for (const token of tokens) {
    // Check for plain token
    if (trimmed === token) {
      return null;
    }

    // Check for markdown-wrapped token (e.g., `HEARTBEAT_OK` or **HEARTBEAT_OK**)
    const markdownWrapped = new RegExp(`^[\`*_]+${token}[\`*_]+$`);
    if (markdownWrapped.test(trimmed)) {
      return null;
    }

    // Check for code block wrapped token
    const codeBlockPattern = new RegExp(`^\`\`\`[\\w]*\\s*${token}\\s*\`\`\`$`, "s");
    if (codeBlockPattern.test(trimmed)) {
      return null;
    }
  }

  // Return original text if not just a suppression token
  return text;
}

/**
 * Persist the heartbeat instructions to the DB (the source of truth).
 */
export async function setHeartbeat(content: string): Promise<void> {
  await setConfigValue(HEARTBEAT_CONFIG_KEY, content);
}

/**
 * Load the heartbeat instructions. The DB is the source of truth; if the DB has
 * none but a HEARTBEAT.md file exists, the file is migrated into the DB on first
 * read (so it stops being a file-only config). Falls back to the file when the DB
 * is unavailable.
 */
export async function getHeartbeat(): Promise<string | null> {
  try {
    const fromDb = await getConfigValue<string>(HEARTBEAT_CONFIG_KEY);
    if (fromDb) return fromDb;
  } catch {
    return loadHeartbeatFile(); // DB unavailable -> file fallback
  }
  const fromFile = loadHeartbeatFile();
  if (fromFile) {
    // Migrate the on-disk file into the DB so it becomes the source of truth.
    await setHeartbeat(fromFile).catch(() => undefined);
  }
  return fromFile;
}
