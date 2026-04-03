/**
 * Tool result storage — deduplication of large tool outputs.
 *
 * When tool results exceed a size threshold, their content is stored
 * once and replaced with a compact reference. On subsequent identical
 * results, the reference is reused instead of sending the full content
 * again. This significantly reduces token usage for repeated file reads,
 * grep results, etc.
 *
 * Adapted from Claude Code's toolResultStorage.ts.
 */

import { createHash } from "node:crypto";

/** Minimum content size (chars) to trigger deduplication. */
const DEDUP_THRESHOLD = 2000;

/** Maximum number of stored results before eviction. */
const MAX_STORED = 500;

/** Stored content entry. */
interface StoredContent {
  hash: string;
  content: string;
  toolName: string;
  firstSeenAt: number;
  accessCount: number;
  /** Rough token count (length / 4). */
  tokenEstimate: number;
}

/**
 * Tool Result Store — manages deduplication of large tool outputs.
 */
export class ToolResultStore {
  private store = new Map<string, StoredContent>();
  private totalTokensSaved = 0;
  private totalDeduplications = 0;

  /**
   * Process a tool result. If it's large enough, store it and return
   * a reference. If it's already stored, return the existing reference.
   *
   * @returns The content to use (original or reference) and whether it was deduped.
   */
  processResult(
    toolName: string,
    content: string,
  ): { content: string; deduplicated: boolean; tokensSaved: number } {
    // Below threshold — pass through unchanged
    if (content.length < DEDUP_THRESHOLD) {
      return { content, deduplicated: false, tokensSaved: 0 };
    }

    const hash = computeHash(content);
    const existing = this.store.get(hash);

    if (existing) {
      // Already stored — return reference
      existing.accessCount += 1;
      const tokensSaved = existing.tokenEstimate;
      this.totalTokensSaved += tokensSaved;
      this.totalDeduplications += 1;

      return {
        content: buildReference(hash, toolName, existing.tokenEstimate),
        deduplicated: true,
        tokensSaved,
      };
    }

    // New content — store it
    const tokenEstimate = Math.ceil(content.length / 4);
    this.store.set(hash, {
      hash,
      content,
      toolName,
      firstSeenAt: Date.now(),
      accessCount: 1,
      tokenEstimate,
    });

    // Evict oldest entries if over limit
    if (this.store.size > MAX_STORED) {
      this.evictOldest();
    }

    // First time seeing this content — return as-is
    return { content, deduplicated: false, tokensSaved: 0 };
  }

  /**
   * Resolve a reference back to its original content.
   * Returns undefined if the reference is not found.
   */
  resolveReference(hash: string): string | undefined {
    const entry = this.store.get(hash);
    if (entry) {
      entry.accessCount += 1;
      return entry.content;
    }
    return undefined;
  }

  /**
   * Get stats about the store.
   */
  getStats(): {
    storedCount: number;
    totalTokensSaved: number;
    totalDeduplications: number;
    totalStoredTokens: number;
  } {
    let totalStoredTokens = 0;
    for (const entry of this.store.values()) {
      totalStoredTokens += entry.tokenEstimate;
    }

    return {
      storedCount: this.store.size,
      totalTokensSaved: this.totalTokensSaved,
      totalDeduplications: this.totalDeduplications,
      totalStoredTokens,
    };
  }

  /**
   * Clear all stored results.
   */
  clear(): void {
    this.store.clear();
    this.totalTokensSaved = 0;
    this.totalDeduplications = 0;
  }

  /**
   * Evict the oldest, least-accessed entries.
   */
  private evictOldest(): void {
    const entries = [...this.store.entries()].sort(([, a], [, b]) => {
      // Sort by access count (ascending), then by age (oldest first)
      if (a.accessCount !== b.accessCount) return a.accessCount - b.accessCount;
      return a.firstSeenAt - b.firstSeenAt;
    });

    // Remove bottom 25%
    const toRemove = Math.floor(entries.length * 0.25);
    for (let i = 0; i < toRemove; i++) {
      this.store.delete(entries[i]![0]);
    }
  }
}

// ── Helpers ──

function computeHash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

function buildReference(hash: string, toolName: string, tokenEstimate: number): string {
  return `[Cached result from ${toolName} — ${tokenEstimate} tokens, ref:${hash}. Content identical to a previous call.]`;
}

// ── Singleton ──

let _store: ToolResultStore | undefined;

export function getToolResultStore(): ToolResultStore {
  if (!_store) {
    _store = new ToolResultStore();
  }
  return _store;
}
