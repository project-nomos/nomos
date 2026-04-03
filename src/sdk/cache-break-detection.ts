/**
 * Prompt cache break detection.
 *
 * Tracks changes to the system prompt and tool schemas that would
 * invalidate the Anthropic API's prompt cache. When a cache break
 * is detected, logs a warning with a diff of what changed so
 * developers can avoid unnecessary cache invalidation.
 *
 * Adapted from Claude Code's promptCacheBreakDetection.ts.
 */

import { createHash } from "node:crypto";

/**
 * Components tracked for cache break detection.
 */
interface CacheableComponents {
  /** System prompt text. */
  systemPrompt: string;
  /** Serialized tool schemas. */
  toolSchemas: string;
  /** Model name. */
  model: string;
  /** Beta flags. */
  betas: string[];
}

interface CacheBreakReport {
  /** Whether a cache break was detected. */
  broken: boolean;
  /** Which component(s) changed. */
  changes: string[];
  /** Human-readable diff summary. */
  summary: string;
}

/**
 * Prompt Cache Tracker — detects cache-breaking changes.
 */
export class PromptCacheTracker {
  private lastHash: string | null = null;
  private lastComponents: CacheableComponents | null = null;
  private breakCount = 0;

  /**
   * Check if the current components would break the cache.
   *
   * Call this before each API request with the current system prompt,
   * tools, model, and betas. Returns a report indicating whether
   * the cache would be invalidated and what changed.
   */
  check(components: CacheableComponents): CacheBreakReport {
    const hash = computeComponentsHash(components);

    // First call — no previous state
    if (this.lastHash === null) {
      this.lastHash = hash;
      this.lastComponents = { ...components };
      return { broken: false, changes: [], summary: "" };
    }

    // No change
    if (hash === this.lastHash) {
      return { broken: false, changes: [], summary: "" };
    }

    // Cache break detected — diff the components
    const changes: string[] = [];
    const prev = this.lastComponents!;

    if (prev.systemPrompt !== components.systemPrompt) {
      changes.push("systemPrompt");
    }
    if (prev.toolSchemas !== components.toolSchemas) {
      changes.push("toolSchemas");
    }
    if (prev.model !== components.model) {
      changes.push(`model (${prev.model} → ${components.model})`);
    }
    if (JSON.stringify(prev.betas) !== JSON.stringify(components.betas)) {
      changes.push("betas");
    }

    this.lastHash = hash;
    this.lastComponents = { ...components };
    this.breakCount += 1;

    const summary = `Cache break #${this.breakCount}: ${changes.join(", ")} changed`;
    console.warn(`[cache-tracker] ${summary}`);

    return { broken: true, changes, summary };
  }

  /**
   * Get the total number of cache breaks detected.
   */
  getBreakCount(): number {
    return this.breakCount;
  }

  /**
   * Reset tracking state (e.g., on /clear or /compact).
   */
  reset(): void {
    this.lastHash = null;
    this.lastComponents = null;
  }
}

// ── Helpers ──

function computeComponentsHash(components: CacheableComponents): string {
  const data = [
    components.systemPrompt,
    components.toolSchemas,
    components.model,
    ...components.betas.sort(),
  ].join("\0");

  return createHash("sha256").update(data).digest("hex").slice(0, 16);
}

// ── Singleton ──

let _tracker: PromptCacheTracker | undefined;

export function getPromptCacheTracker(): PromptCacheTracker {
  if (!_tracker) {
    _tracker = new PromptCacheTracker();
  }
  return _tracker;
}
