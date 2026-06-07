/**
 * Memory loop observability.
 *
 * Emits one structured event per memory operation (recall + write) so the memory
 * loop is observable in production: what got searched, how often a search came
 * back empty (recall hit rate), and what got written, per owner. Events go to the
 * `memory-trace` logger (pino, structured) so they can be shipped to a log
 * aggregator, and a lightweight in-process tally backs a quick `getMemoryStats()`
 * for the settings admin / CLI.
 *
 * This is the "traces" half of the traces + monitoring + evals follow-up; the
 * recall eval (pnpm eval:recall) and isolation check (pnpm check:isolation) are
 * the evals half.
 */

import { createLogger } from "../lib/logger.ts";

const log = createLogger("memory-trace");

export type MemoryOp =
  | "recall_search" // hybrid/vector/FTS memory_search
  | "recall_vault" // vault keyword search
  | "write_vault" // vault note written/revised
  | "write_chunk" // conversation/extraction chunk indexed
  | "forget"; // note + chunks removed

export interface MemoryTraceEvent {
  op: MemoryOp;
  userId: string;
  /** Search text, for recall ops. */
  query?: string;
  /** Result count, for recall ops. A recall is a "miss" when this is 0. */
  resultCount?: number;
  /** Chunks/notes written, for write ops. */
  writeCount?: number;
  /** Path/source, when relevant. */
  ref?: string;
  /** Wall-clock latency in ms. */
  latencyMs?: number;
}

interface MemoryStats {
  recalls: number;
  recallHits: number; // recalls that returned >= 1 result
  writes: number;
}

const stats: MemoryStats = { recalls: 0, recallHits: 0, writes: 0 };

/** Record + log a single memory event. Never throws; observability must not break the loop. */
export function traceMemory(event: MemoryTraceEvent): void {
  try {
    if (event.op === "recall_search" || event.op === "recall_vault") {
      stats.recalls += 1;
      if ((event.resultCount ?? 0) > 0) stats.recallHits += 1;
    } else if (event.op === "write_vault" || event.op === "write_chunk") {
      stats.writes += 1;
    }
    log.debug(event, `memory.${event.op}`);
  } catch {
    /* observability is best-effort */
  }
}

/**
 * Time an async recall and trace it. Returns the recall's result unchanged.
 * Usage: `return tracedRecall("recall_search", userId, query, () => hybridSearch(...))`.
 */
export async function tracedRecall<T>(
  op: "recall_search" | "recall_vault",
  userId: string,
  query: string,
  fn: () => Promise<T[]>,
): Promise<T[]> {
  const start = Date.now();
  const results = await fn();
  traceMemory({ op, userId, query, resultCount: results.length, latencyMs: Date.now() - start });
  return results;
}

/** Snapshot of the in-process memory tally (recall hit rate + write count). */
export function getMemoryStats(): MemoryStats & { recallHitRate: number } {
  return {
    ...stats,
    recallHitRate: stats.recalls > 0 ? stats.recallHits / stats.recalls : 0,
  };
}
