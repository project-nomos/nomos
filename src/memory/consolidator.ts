/**
 * Memory consolidation — auto-dream system.
 *
 * Periodically reviews memory chunks, merges duplicates,
 * prunes stale low-access entries, and updates confidence scores.
 * Inspired by Claude Code's autoDream consolidation pattern.
 */

import { getDb } from "../db/client.ts";

export interface ConsolidationResult {
  merged: number;
  pruned: number;
  totalBefore: number;
  totalAfter: number;
}

/** Minimum age (days) before a chunk is eligible for pruning. */
const MIN_AGE_DAYS = 7;

/** Maximum access count for pruning eligibility — chunks accessed more than this are kept. */
const PRUNE_ACCESS_THRESHOLD = 1;

/** Similarity threshold for merging (cosine similarity). */
const MERGE_SIMILARITY_THRESHOLD = 0.92;

/** Maximum chunks to prune in a single consolidation run. */
const MAX_PRUNE_PER_RUN = 100;

/**
 * Run a full consolidation cycle:
 * 1. Find and merge near-duplicate chunks (by vector similarity)
 * 2. Prune stale chunks with low access count
 * 3. Update user model confidence based on recency
 */
export async function consolidateMemory(): Promise<ConsolidationResult> {
  const sql = getDb();

  // Count before
  const [{ count: totalBefore }] = await sql`SELECT count(*)::int AS count FROM memory_chunks`;

  // Phase 1: Prune old, rarely-accessed chunks
  const pruned = await pruneStaleChunks();

  // Phase 2: Merge near-duplicate chunks (vector similarity)
  const merged = await mergeNearDuplicates();

  // Phase 3: Decay user model confidence for stale entries
  await decayUserModelConfidence();

  // Count after
  const [{ count: totalAfter }] = await sql`SELECT count(*)::int AS count FROM memory_chunks`;

  return { merged, pruned, totalBefore, totalAfter };
}

/** Remove chunks that are old and rarely accessed. */
async function pruneStaleChunks(): Promise<number> {
  const sql = getDb();
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - MIN_AGE_DAYS);

  const deleted = await sql`
    DELETE FROM memory_chunks
    WHERE id IN (
      SELECT id FROM memory_chunks
      WHERE access_count <= ${PRUNE_ACCESS_THRESHOLD}
        AND created_at < ${cutoffDate}
        AND (last_accessed_at IS NULL OR last_accessed_at < ${cutoffDate})
        AND (metadata->>'category') NOT IN ('correction', 'skill')
      ORDER BY access_count ASC, created_at ASC
      LIMIT ${MAX_PRUNE_PER_RUN}
    )
    RETURNING id
  `;

  return deleted.length;
}

/** Find and merge near-duplicate chunks based on vector similarity. */
async function mergeNearDuplicates(): Promise<number> {
  const sql = getDb();
  let mergeCount = 0;

  // Find pairs of chunks with very high cosine similarity
  const duplicatePairs = await sql`
    SELECT
      a.id AS id_a,
      b.id AS id_b,
      a.text AS text_a,
      b.text AS text_b,
      a.access_count AS access_a,
      b.access_count AS access_b,
      a.created_at AS created_a,
      b.created_at AS created_b,
      1 - (a.embedding <=> b.embedding) AS similarity
    FROM memory_chunks a
    JOIN memory_chunks b ON a.id < b.id
    WHERE a.embedding IS NOT NULL
      AND b.embedding IS NOT NULL
      AND 1 - (a.embedding <=> b.embedding) > ${MERGE_SIMILARITY_THRESHOLD}
    ORDER BY similarity DESC
    LIMIT 50
  `;

  const deletedIds = new Set<string>();

  for (const pair of duplicatePairs) {
    if (deletedIds.has(pair.id_a) || deletedIds.has(pair.id_b)) continue;

    // Keep the chunk with more accesses, or the newer one if equal
    const keepId =
      pair.access_a > pair.access_b
        ? pair.id_a
        : pair.access_a < pair.access_b
          ? pair.id_b
          : pair.created_a > pair.created_b
            ? pair.id_a
            : pair.id_b;
    const removeId = keepId === pair.id_a ? pair.id_b : pair.id_a;

    // Merge: combine access counts and update the kept chunk
    const combinedAccess = pair.access_a + pair.access_b;
    await sql`
      UPDATE memory_chunks
      SET access_count = ${combinedAccess}, updated_at = now()
      WHERE id = ${keepId}
    `;

    await sql`DELETE FROM memory_chunks WHERE id = ${removeId}`;
    deletedIds.add(removeId);
    mergeCount++;
  }

  return mergeCount;
}

/** Reduce confidence of user model entries that haven't been reinforced recently. */
async function decayUserModelConfidence(): Promise<void> {
  const sql = getDb();
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - 30);

  // Decay confidence by 10% for entries not updated in 30+ days
  await sql`
    UPDATE user_model
    SET confidence = GREATEST(confidence * 0.9, 0.1),
        updated_at = now()
    WHERE updated_at < ${cutoffDate}
      AND confidence > 0.1
  `;
}
