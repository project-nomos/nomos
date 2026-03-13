import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
