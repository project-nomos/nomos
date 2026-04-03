/**
 * Magic Docs — self-updating markdown documentation.
 *
 * Markdown files marked with `<!-- MAGIC DOC: title -->` are automatically
 * kept up-to-date. When a magic doc is read, the system checks if it's
 * stale (based on last update time and related file changes), and if so,
 * queues a background update via a forked agent.
 *
 * Adapted from Claude Code's MagicDocs service.
 *
 * Usage:
 * 1. Add `<!-- MAGIC DOC: API Reference -->` to any .md file
 * 2. When the agent reads the file, it detects the marker
 * 3. If the doc is stale, a background agent updates it
 * 4. The doc is rewritten in place, preserving the marker
 */

import { readFile, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

/** Marker regex to detect magic doc files. */
const MAGIC_DOC_MARKER = /<!--\s*MAGIC DOC:\s*(.+?)\s*-->/;

/** Minimum time between updates for the same doc (1 hour). */
const MIN_UPDATE_INTERVAL_MS = 60 * 60 * 1000;

/** State file tracking last update times. */
const STATE_FILE = join(homedir(), ".nomos", "magic-docs-state.json");

interface MagicDocState {
  /** Map of file path → last update timestamp. */
  lastUpdated: Record<string, string>;
}

/**
 * Check if a file is a magic doc and extract its title.
 * Returns the title if found, null otherwise.
 */
export function detectMagicDoc(content: string): string | null {
  const match = content.match(MAGIC_DOC_MARKER);
  return match ? match[1]!.trim() : null;
}

/**
 * Check if a magic doc is stale and needs updating.
 */
export async function isMagicDocStale(filePath: string): Promise<boolean> {
  const state = await loadState();
  const lastUpdated = state.lastUpdated[filePath];

  if (!lastUpdated) {
    // Never updated — definitely stale
    return true;
  }

  const elapsed = Date.now() - new Date(lastUpdated).getTime();
  if (elapsed < MIN_UPDATE_INTERVAL_MS) {
    // Updated recently — not stale
    return false;
  }

  // Check if any source files have changed since last update
  // (heuristic: check if the doc's own mtime is newer than last update)
  try {
    const fileStat = await stat(filePath);
    const fileModified = fileStat.mtime.getTime();
    const lastUpdate = new Date(lastUpdated).getTime();
    return fileModified > lastUpdate || elapsed > MIN_UPDATE_INTERVAL_MS;
  } catch {
    return true;
  }
}

/**
 * Build the prompt for updating a magic doc.
 */
export function buildMagicDocUpdatePrompt(
  title: string,
  currentContent: string,
  filePath: string,
): string {
  return `You are updating a self-maintaining documentation file.

## Document Info
- Title: ${title}
- Path: ${filePath}

## Current Content
\`\`\`markdown
${currentContent}
\`\`\`

## Instructions
1. Read the codebase to understand what this document should cover
2. Update the content to reflect the current state of the code
3. Preserve the \`<!-- MAGIC DOC: ${title} -->\` marker at the top
4. Keep the same general structure and sections
5. Update code examples, API signatures, and descriptions as needed
6. Remove references to deleted code; add references to new code
7. Be concise and accurate — this is reference documentation

Output ONLY the updated markdown content (including the marker).
Do not wrap in code fences or add explanations.`;
}

/**
 * Mark a magic doc as updated.
 */
export async function markMagicDocUpdated(filePath: string): Promise<void> {
  const state = await loadState();
  state.lastUpdated[filePath] = new Date().toISOString();
  await saveState(state);
}

/**
 * Update a magic doc file with new content.
 * Preserves the marker and writes the updated content.
 */
export async function writeMagicDoc(filePath: string, newContent: string): Promise<void> {
  // Ensure the marker is present
  if (!MAGIC_DOC_MARKER.test(newContent)) {
    const title = detectMagicDoc(await readFile(filePath, "utf-8"));
    if (title) {
      newContent = `<!-- MAGIC DOC: ${title} -->\n\n${newContent}`;
    }
  }

  await writeFile(filePath, newContent, "utf-8");
  await markMagicDocUpdated(filePath);
}

// ── State Management ──

async function loadState(): Promise<MagicDocState> {
  try {
    const content = await readFile(STATE_FILE, "utf-8");
    return JSON.parse(content) as MagicDocState;
  } catch {
    return { lastUpdated: {} };
  }
}

async function saveState(state: MagicDocState): Promise<void> {
  const { mkdir: mkdirFs } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  await mkdirFs(dirname(STATE_FILE), { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
}
