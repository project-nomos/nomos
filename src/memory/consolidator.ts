/**
 * Memory consolidation — auto-dream system.
 *
 * Four-phase consolidation inspired by Claude Code's autoDream:
 * 1. Orient: Gather memory stats and identify areas needing attention
 * 2. Gather Signal: Load candidate chunks for LLM review
 * 3. Consolidate: LLM rewrites/merges/prunes chunks intelligently
 * 4. Prune: SQL-based cleanup of stale, low-access entries
 *
 * Uses a lightweight LLM (Haiku) for semantic understanding of memory content.
 */

import { getDb } from "../db/client.ts";
import { loadEnvConfig } from "../config/env.ts";

export interface ConsolidationResult {
  merged: number;
  pruned: number;
  rewritten: number;
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
 * 1. Prune old, rarely-accessed chunks (SQL)
 * 2. Merge near-duplicate chunks by vector similarity (SQL)
 * 3. LLM-powered review: rewrite/merge semantically similar chunks (Haiku)
 * 4. Decay user model confidence for stale entries
 */
export async function consolidateMemory(): Promise<ConsolidationResult> {
  const sql = getDb();

  // Count before
  const [{ count: totalBefore }] = await sql`SELECT count(*)::int AS count FROM memory_chunks`;

  // Phase 1: Prune old, rarely-accessed chunks
  const pruned = await pruneStaleChunks();

  // Phase 2: Merge near-duplicate chunks (vector similarity)
  const merged = await mergeNearDuplicates();

  // Phase 3: LLM-powered review and rewrite
  const rewritten = await llmConsolidate();

  // Phase 4: Decay user model confidence for stale entries
  await decayUserModelConfidence();

  // Count after
  const [{ count: totalAfter }] = await sql`SELECT count(*)::int AS count FROM memory_chunks`;

  return { merged, pruned, rewritten, totalBefore, totalAfter };
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

const LLM_CONSOLIDATION_PROMPT = `You are a memory consolidation system. Review these memory chunks and decide what to do with each.

Memory chunks to review:
{chunks}

For each chunk, decide ONE action:
- KEEP: Important, unique information — leave as-is
- REWRITE: Useful but verbose/messy — provide a cleaner version
- MERGE: Combine with another chunk (specify which by ID)
- DROP: Redundant, outdated, or trivially obvious — remove

Return ONLY a JSON array of decisions:
[{"id": "chunk-id", "action": "KEEP|REWRITE|MERGE|DROP", "rewrite": "new text if REWRITE", "merge_with": "other-id if MERGE"}]

Guidelines:
- Prefer concise, factual summaries over verbose conversational records
- Merge chunks that say the same thing in different words
- Drop chunks that state the obvious or repeat common knowledge
- Keep corrections, user preferences, and unique project-specific facts
- When rewriting, preserve the core information but make it concise`;

/** Maximum chunks to review per LLM consolidation pass. */
const LLM_BATCH_SIZE = 20;

/**
 * LLM-powered consolidation: sends batches of memory chunks to Haiku
 * for semantic review, rewriting, and intelligent pruning.
 */
async function llmConsolidate(): Promise<number> {
  const sql = getDb();
  const config = loadEnvConfig();
  const model = config.extractionModel ?? "claude-haiku-4-5";

  // Select candidates: older chunks with moderate access, grouped by category
  const candidates = await sql`
    SELECT id, text, metadata, access_count, created_at
    FROM memory_chunks
    WHERE created_at < now() - interval '3 days'
    ORDER BY access_count ASC, created_at ASC
    LIMIT ${LLM_BATCH_SIZE}
  `;

  if (candidates.length < 3) return 0; // Not enough to consolidate

  // Format chunks for the LLM
  const chunksText = candidates
    .map((c) => {
      const cat = (c.metadata as Record<string, unknown>)?.category ?? "unknown";
      return `[${c.id}] (${cat}, accessed: ${c.access_count}x)\n${(c.text as string).slice(0, 300)}`;
    })
    .join("\n\n");

  const prompt = LLM_CONSOLIDATION_PROMPT.replace("{chunks}", chunksText);

  try {
    const { runSession } = await import("../sdk/session.ts");

    let fullText = "";
    const sdkQuery = runSession({
      prompt,
      model,
      systemPrompt:
        "You are a JSON decision system. Output only valid JSON arrays. No explanations.",
      permissionMode: "plan",
      maxTurns: 1,
      mcpServers: {},
    });

    for await (const msg of sdkQuery) {
      if (msg.type === "assistant") {
        for (const block of msg.message.content) {
          if (block.type === "text" && block.text) fullText += block.text;
        }
      }
      if (msg.type === "result") {
        for (const block of msg.result) {
          if ((block as { type: string; text?: string }).type === "text") {
            fullText += (block as { type: string; text: string }).text;
          }
        }
      }
    }

    // Parse LLM decisions
    const jsonMatch = fullText.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return 0;

    const decisions = JSON.parse(jsonMatch[0]) as Array<{
      id: string;
      action: string;
      rewrite?: string;
      merge_with?: string;
    }>;

    let changeCount = 0;
    const validIds = new Set(candidates.map((c) => c.id));

    for (const decision of decisions) {
      if (!validIds.has(decision.id)) continue;

      switch (decision.action.toUpperCase()) {
        case "DROP": {
          await sql`DELETE FROM memory_chunks WHERE id = ${decision.id}`;
          changeCount++;
          break;
        }
        case "REWRITE": {
          if (decision.rewrite && decision.rewrite.length > 10) {
            // Update text, optionally regenerate embedding
            await sql`
              UPDATE memory_chunks
              SET text = ${decision.rewrite}, updated_at = now()
              WHERE id = ${decision.id}
            `;

            // Try to regenerate embedding for the rewritten text
            try {
              const { isEmbeddingAvailable, generateEmbedding } = await import("./embeddings.ts");
              if (isEmbeddingAvailable()) {
                const embedding = await generateEmbedding(decision.rewrite);
                const embeddingStr = `[${embedding.join(",")}]`;
                await sql`
                  UPDATE memory_chunks
                  SET embedding = ${embeddingStr}::vector
                  WHERE id = ${decision.id}
                `;
              }
            } catch {
              // Continue without embedding update
            }

            changeCount++;
          }
          break;
        }
        case "MERGE": {
          if (decision.merge_with && validIds.has(decision.merge_with)) {
            // Combine access counts into the target, delete the source
            const [target] = await sql`
              SELECT access_count FROM memory_chunks WHERE id = ${decision.merge_with}
            `;
            const [source] = await sql`
              SELECT access_count FROM memory_chunks WHERE id = ${decision.id}
            `;
            if (target && source) {
              const combined = (target.access_count as number) + (source.access_count as number);
              await sql`
                UPDATE memory_chunks
                SET access_count = ${combined}, updated_at = now()
                WHERE id = ${decision.merge_with}
              `;
              await sql`DELETE FROM memory_chunks WHERE id = ${decision.id}`;
              changeCount++;
            }
          }
          break;
        }
        // KEEP: no action needed
      }
    }

    if (changeCount > 0) {
      console.log(
        `[consolidator] LLM review: ${changeCount} changes from ${decisions.length} decisions`,
      );
    }

    return changeCount;
  } catch (err) {
    console.debug("[consolidator] LLM consolidation failed:", err);
    return 0;
  }
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
