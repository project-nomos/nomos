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

import { sql, type SqlBool } from "kysely";
import { getKysely } from "../db/client.ts";
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
  const db = getKysely();

  // Count before
  const before = await db
    .selectFrom("memory_chunks")
    .select(sql<number>`count(*)::int`.as("count"))
    .executeTakeFirstOrThrow();
  const totalBefore = before.count;

  // Phase 1: Prune old, rarely-accessed chunks
  const pruned = await pruneStaleChunks();

  // Phase 2: Merge near-duplicate chunks (vector similarity)
  const merged = await mergeNearDuplicates();

  // Phase 3: LLM-powered review and rewrite
  const rewritten = await llmConsolidate();

  // Phase 4: Decay user model confidence for stale entries
  await decayUserModelConfidence();

  // Count after
  const after = await db
    .selectFrom("memory_chunks")
    .select(sql<number>`count(*)::int`.as("count"))
    .executeTakeFirstOrThrow();

  return { merged, pruned, rewritten, totalBefore, totalAfter: after.count };
}

/** Remove chunks that are old and rarely accessed. */
async function pruneStaleChunks(): Promise<number> {
  const db = getKysely();
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - MIN_AGE_DAYS);

  const deleted = await db
    .deleteFrom("memory_chunks")
    .where(
      "id",
      "in",
      db
        .selectFrom("memory_chunks")
        .select("id")
        .where("access_count", "<=", PRUNE_ACCESS_THRESHOLD)
        .where("created_at", "<", cutoffDate)
        .where((eb) =>
          eb.or([eb("last_accessed_at", "is", null), eb("last_accessed_at", "<", cutoffDate)]),
        )
        .where(sql<SqlBool>`(metadata->>'category') NOT IN ('correction', 'skill')`)
        .orderBy("access_count", "asc")
        .orderBy("created_at", "asc")
        .limit(MAX_PRUNE_PER_RUN),
    )
    .returning("id")
    .execute();

  return deleted.length;
}

/** Find and merge near-duplicate chunks based on vector similarity. */
async function mergeNearDuplicates(): Promise<number> {
  const db = getKysely();
  let mergeCount = 0;

  // Find pairs of chunks with very high cosine similarity
  const duplicatePairs = await db
    .selectFrom("memory_chunks as a")
    .innerJoin("memory_chunks as b", (join) => join.on(sql`a.id < b.id`))
    .select([
      "a.id as id_a",
      "b.id as id_b",
      "a.text as text_a",
      "b.text as text_b",
      "a.access_count as access_a",
      "b.access_count as access_b",
      "a.created_at as created_a",
      "b.created_at as created_b",
      sql<number>`1 - (a.embedding <=> b.embedding)`.as("similarity"),
    ])
    .where("a.embedding", "is not", null)
    .where("b.embedding", "is not", null)
    .where(sql`1 - (a.embedding <=> b.embedding)`, ">", MERGE_SIMILARITY_THRESHOLD)
    .orderBy("similarity", "desc")
    .limit(50)
    .execute();

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
    await db
      .updateTable("memory_chunks")
      .set({ access_count: combinedAccess, updated_at: sql`now()` })
      .where("id", "=", keepId)
      .execute();

    await db.deleteFrom("memory_chunks").where("id", "=", removeId).execute();
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
  const db = getKysely();
  const config = loadEnvConfig();
  const model = config.extractionModel ?? "claude-haiku-4-5";

  // Select candidates: older chunks with moderate access, grouped by category
  const candidates = await db
    .selectFrom("memory_chunks")
    .select(["id", "text", "metadata", "access_count", "created_at"])
    .where("created_at", "<", sql<Date>`now() - interval '3 days'`)
    .orderBy("access_count", "asc")
    .orderBy("created_at", "asc")
    .limit(LLM_BATCH_SIZE)
    .execute();

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
          await db.deleteFrom("memory_chunks").where("id", "=", decision.id).execute();
          changeCount++;
          break;
        }
        case "REWRITE": {
          if (decision.rewrite && decision.rewrite.length > 10) {
            await db
              .updateTable("memory_chunks")
              .set({ text: decision.rewrite, updated_at: sql`now()` })
              .where("id", "=", decision.id)
              .execute();

            // Try to regenerate embedding for the rewritten text
            try {
              const { isEmbeddingAvailable, generateEmbedding } = await import("./embeddings.ts");
              if (isEmbeddingAvailable()) {
                const embedding = await generateEmbedding(decision.rewrite);
                const embeddingStr = `[${embedding.join(",")}]`;
                await db
                  .updateTable("memory_chunks")
                  .set({ embedding: sql`${embeddingStr}::vector` })
                  .where("id", "=", decision.id)
                  .execute();
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
            const target = await db
              .selectFrom("memory_chunks")
              .select("access_count")
              .where("id", "=", decision.merge_with)
              .executeTakeFirst();
            const source = await db
              .selectFrom("memory_chunks")
              .select("access_count")
              .where("id", "=", decision.id)
              .executeTakeFirst();
            if (target && source) {
              const combined = target.access_count + source.access_count;
              await db
                .updateTable("memory_chunks")
                .set({ access_count: combined, updated_at: sql`now()` })
                .where("id", "=", decision.merge_with)
                .execute();
              await db.deleteFrom("memory_chunks").where("id", "=", decision.id).execute();
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
  const db = getKysely();
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - 30);

  // Decay confidence by 10% for entries not updated in 30+ days
  await db
    .updateTable("user_model")
    .set({
      confidence: sql`GREATEST(confidence * 0.9, 0.1)`,
      updated_at: sql`now()`,
    })
    .where("updated_at", "<", cutoffDate)
    .where("confidence", ">", 0.1)
    .execute();
}
