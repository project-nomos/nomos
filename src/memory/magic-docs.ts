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

import { readFile, writeFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { getKysely } from "../db/client.ts";
import { runForkedAgent } from "../sdk/forked-agent.ts";
import { createLogger } from "../lib/logger.ts";

const log = createLogger("magic-docs");

/** SHA-256 of a doc's content, for content-addressed staleness. */
function contentHash(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

/**
 * Marker regex to detect magic doc files. The marker must be ALONE on its own
 * line (only surrounding whitespace) to count -- otherwise a doc that merely
 * *documents* the syntax (e.g. README/CLAUDE.md describing Magic Docs with an
 * inline `<!-- MAGIC DOC: title -->` in a sentence or code span) would be
 * detected as a magic doc and auto-rewritten in place. Anchored + multiline so
 * only a real, standalone marker line matches.
 */
const MAGIC_DOC_MARKER = /^[ \t]*<!--[ \t]*MAGIC DOC:[ \t]*(.+?)[ \t]*-->[ \t]*$/m;

/** Minimum time between updates for the same doc (1 hour). */
const MIN_UPDATE_INTERVAL_MS = 60 * 60 * 1000;

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
 *
 * Staleness is content-addressed plus time-gated:
 * - never updated -> stale
 * - the file content changed since the last update (hash mismatch) -> stale,
 *   so a manual edit re-syncs the doc immediately
 * - otherwise, stale once the refresh interval has elapsed (periodic
 *   re-check that catches drift in the source the doc documents)
 */
export async function isMagicDocStale(filePath: string): Promise<boolean> {
  const state = await loadMagicDocState(filePath);

  if (!state.lastUpdated) {
    // Never updated -> definitely stale.
    return true;
  }

  // Content-addressed: if the doc's bytes differ from what we last wrote, it
  // was edited (or never hashed) and should be re-synced now.
  if (state.lastHash) {
    try {
      const current = contentHash(await readFile(filePath, "utf-8"));
      if (current !== state.lastHash) return true;
    } catch {
      return true;
    }
  }

  // Otherwise refresh on the interval to catch source drift.
  const elapsed = Date.now() - new Date(state.lastUpdated).getTime();
  return elapsed >= MIN_UPDATE_INTERVAL_MS;
}

/**
 * STABLE step text for the magic-doc update fork. Byte-identical across every
 * doc so the SDK caches it in the system-prompt prefix (via `systemPromptAppend`).
 * The per-doc title/path/content and the marker-preservation line stay in the
 * dynamic prompt (see `buildMagicDocUpdatePrompt`) — they cannot cache.
 */
const MAGIC_DOC_UPDATE_INSTRUCTIONS = `You are updating a self-maintaining documentation file.

## Instructions
1. Read the codebase to understand what this document should cover
2. Update the content to reflect the current state of the code
3. Preserve the magic-doc marker at the top (the caller's prompt names the exact marker)
4. Keep the same general structure and sections
5. Update code examples, API signatures, and descriptions as needed
6. Remove references to deleted code; add references to new code
7. Be concise and accurate — this is reference documentation

Output ONLY the updated markdown content (including the marker).
Do not wrap in code fences or add explanations.`;

/**
 * Build the DYNAMIC prompt for updating a magic doc. Only the per-doc data
 * (title, path, current content, and the exact marker to preserve) lives here;
 * the stable step text is `MAGIC_DOC_UPDATE_INSTRUCTIONS`, passed as
 * `systemPromptAppend` so it caches in the prefix.
 */
export function buildMagicDocUpdatePrompt(
  title: string,
  currentContent: string,
  filePath: string,
): string {
  return `## Document Info
- Title: ${title}
- Path: ${filePath}

Preserve this marker at the top: \`<!-- MAGIC DOC: ${title} -->\`

## Current Content
\`\`\`markdown
${currentContent}
\`\`\``;
}

/**
 * Mark a magic doc as updated.
 *
 * Persists the content hash (for content-addressed staleness) and an
 * optional metadata bag (title, model, etc.) into state_json.
 */
export async function markMagicDocUpdated(
  filePath: string,
  opts?: { contentHash?: string; state?: Record<string, unknown> },
): Promise<void> {
  try {
    const db = getKysely();
    // Pass the OBJECT (not JSON.stringify): postgres-js serializes to jsonb once.
    // Stringifying first double-encodes into a jsonb *string*.
    const stateJson = (opts?.state ?? null) as unknown as string | null;
    await db
      .insertInto("magic_doc_state")
      .values({
        file_path: filePath,
        last_updated_at: new Date(),
        last_content_hash: opts?.contentHash ?? null,
        state_json: stateJson,
      })
      .onConflict((oc) =>
        oc.column("file_path").doUpdateSet({
          last_updated_at: new Date(),
          last_content_hash: opts?.contentHash ?? null,
          state_json: stateJson,
        }),
      )
      .execute();
  } catch (err) {
    log.warn({ err, filePath }, "Failed to mark magic doc updated");
  }
}

/**
 * Update a magic doc file with new content.
 * Preserves the marker, writes the content, and records its hash + metadata
 * so the next staleness check is content-addressed.
 */
export async function writeMagicDoc(filePath: string, newContent: string): Promise<void> {
  // Ensure the marker is present
  let title = detectMagicDoc(newContent);
  if (!title) {
    title = detectMagicDoc(await readFile(filePath, "utf-8"));
    if (title) {
      newContent = `<!-- MAGIC DOC: ${title} -->\n\n${newContent}`;
    }
  }

  await writeFile(filePath, newContent, "utf-8");
  await markMagicDocUpdated(filePath, {
    contentHash: contentHash(newContent),
    state: { title: title ?? null, chars: newContent.length },
  });
}

// ── State Management ──

interface MagicDocState {
  lastUpdated?: string;
  lastHash?: string;
}

async function loadMagicDocState(filePath: string): Promise<MagicDocState> {
  try {
    const db = getKysely();
    const row = await db
      .selectFrom("magic_doc_state")
      .select(["last_updated_at", "last_content_hash"])
      .where("file_path", "=", filePath)
      .executeTakeFirst();
    if (!row) return {};
    return {
      lastUpdated: row.last_updated_at ? new Date(row.last_updated_at).toISOString() : undefined,
      lastHash: row.last_content_hash ?? undefined,
    };
  } catch (err) {
    log.warn({ err, filePath }, "Failed to load magic doc state");
    return {};
  }
}

// ── Background Runner ──

/** Default roots scanned (shallowly) for magic-doc markdown files. */
function defaultMagicDocRoots(): string[] {
  return [process.cwd(), path.join(process.cwd(), ".nomos"), path.join(homedir(), ".nomos")];
}

/**
 * Canonical, hand-maintained docs that must NEVER be auto-rewritten, even if a
 * standalone marker slips in (e.g. a fenced code example). Defense-in-depth on top
 * of the own-line marker rule: these files are the project's source of truth.
 */
const NEVER_MAGIC = new Set(["CLAUDE.md", "README.md", "AGENTS.md"]);

/**
 * Find magic-doc files under the given roots (non-recursive scan of each root,
 * cheap + bounded). A file qualifies if it ends in `.md`, is not a canonical
 * hand-maintained doc, and contains a standalone marker line.
 */
async function findMagicDocs(roots: string[]): Promise<string[]> {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch {
      continue; // root doesn't exist
    }
    for (const name of entries) {
      if (!name.endsWith(".md")) continue;
      if (NEVER_MAGIC.has(name)) continue; // never auto-rewrite canonical docs
      const full = path.join(root, name);
      if (seen.has(full)) continue;
      seen.add(full);
      try {
        const content = await readFile(full, "utf-8");
        if (detectMagicDoc(content)) found.push(full);
      } catch {
        // unreadable; skip
      }
    }
  }
  return found;
}

/**
 * Refresh all stale magic docs found under `roots` (or a sensible default set).
 *
 * For each stale doc, runs a forked agent with the update prompt and writes the
 * result back in place. Fire-and-forget safe: failures are logged, not thrown.
 * Returns a summary of what was scanned, refreshed, and skipped.
 */
export async function refreshMagicDocs(
  roots?: string[],
): Promise<{ scanned: number; refreshed: number; skipped: number; failed: number }> {
  const docs = await findMagicDocs(roots ?? defaultMagicDocRoots());
  let refreshed = 0;
  let skipped = 0;
  let failed = 0;

  for (const filePath of docs) {
    try {
      if (!(await isMagicDocStale(filePath))) {
        skipped++;
        continue;
      }
      const current = await readFile(filePath, "utf-8");
      const title = detectMagicDoc(current);
      if (!title) {
        skipped++;
        continue;
      }
      const result = await runForkedAgent({
        prompt: buildMagicDocUpdatePrompt(title, current, filePath),
        systemPromptAppend: MAGIC_DOC_UPDATE_INSTRUCTIONS,
        // Genuinely tool-using: reads several source files, then rewrites one doc.
        // Opt into the full toolset (forks now default to no tools). maxTurns is a
        // CEILING, not a per-call cost — keep ample headroom so a doc referencing many
        // files still lands its rewrite instead of dying at "max turns" (→ silent staleness).
        fullTools: true,
        maxTurns: 15,
        label: "magic-doc",
      });
      const next = result.text.trim();
      if (!next || next.length < 20) {
        // Agent produced nothing usable; leave the doc untouched.
        skipped++;
        continue;
      }
      await writeMagicDoc(filePath, next);
      refreshed++;
      log.info({ filePath, title }, "Magic doc refreshed");
    } catch (err) {
      failed++;
      log.warn({ err, filePath }, "Failed to refresh magic doc");
    }
  }

  log.info({ scanned: docs.length, refreshed, skipped, failed }, "Magic docs refresh complete");
  return { scanned: docs.length, refreshed, skipped, failed };
}
