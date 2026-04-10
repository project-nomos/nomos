/**
 * Deduplication for the ingestion pipeline.
 *
 * Uses SHA-256 hash of (platform + contact + timestamp + content) to detect
 * messages already stored in memory_chunks.
 */

import { createHash } from "node:crypto";
import { getDb } from "../db/client.ts";
import type { IngestMessage } from "./types.ts";

/** Compute a deterministic hash for an ingested message. */
export function computeMessageHash(msg: IngestMessage): string {
  return createHash("sha256")
    .update(`${msg.platform}:${msg.contact}:${msg.timestamp.toISOString()}:${msg.content}`)
    .digest("hex");
}

/**
 * Check which hashes already exist in memory_chunks.
 * Returns a Set of hashes that are already stored.
 */
export async function findExistingHashes(hashes: string[]): Promise<Set<string>> {
  if (hashes.length === 0) return new Set();

  const sql = getDb();
  const rows = await sql<{ hash: string }[]>`
    SELECT hash FROM memory_chunks
    WHERE hash = ANY(${hashes})
  `;

  return new Set(rows.map((r) => r.hash));
}

/**
 * Filter a batch of messages, returning only those not already stored.
 * Also returns the hash for each message so the pipeline can store it.
 */
export async function deduplicateBatch(
  messages: IngestMessage[],
): Promise<Array<{ message: IngestMessage; hash: string }>> {
  const hashMap = new Map<string, IngestMessage>();
  for (const msg of messages) {
    hashMap.set(computeMessageHash(msg), msg);
  }

  const existing = await findExistingHashes([...hashMap.keys()]);

  const results: Array<{ message: IngestMessage; hash: string }> = [];
  for (const [hash, message] of hashMap) {
    if (!existing.has(hash)) {
      results.push({ message, hash });
    }
  }
  return results;
}
