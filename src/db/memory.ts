import { sql } from "kysely";
import { getKysely } from "./client.ts";
import { cosineDistance, cosineSimilarity, ftsMatch, ftsRank } from "./sql-helpers.ts";

export interface MemoryChunk {
  id: string;
  /** Owner of this chunk (per-user scoping; resolveMemoryUserId at the boundary). */
  userId: string;
  source: string;
  path?: string;
  text: string;
  embedding?: number[];
  startLine?: number;
  endLine?: number;
  hash?: string;
  model?: string;
  metadata?: Record<string, unknown>;
}

export interface MemorySearchResult {
  id: string;
  text: string;
  path: string | null;
  source: string;
  score: number;
  created_at?: Date;
  access_count?: number;
  metadata?: Record<string, unknown>;
}

export async function storeMemoryChunk(chunk: MemoryChunk): Promise<void> {
  const db = getKysely();
  const embeddingStr = chunk.embedding ? `[${chunk.embedding.join(",")}]` : null;

  await db
    .insertInto("memory_chunks")
    .values({
      id: chunk.id,
      user_id: chunk.userId,
      source: chunk.source,
      path: chunk.path ?? null,
      text: chunk.text,
      embedding: embeddingStr ? sql`${embeddingStr}::vector` : null,
      start_line: chunk.startLine ?? null,
      end_line: chunk.endLine ?? null,
      hash: chunk.hash ?? null,
      model: chunk.model ?? null,
      // Pass the metadata OBJECT, not a pre-stringified string: the postgres-js
      // driver serializes an object to jsonb exactly once. Passing a JSON string
      // double-encodes it into a jsonb *string* ("{\"category\":...}") instead of an
      // object, silently breaking metadata->>'category' filters (category search + prune).
      metadata: (chunk.metadata ?? {}) as unknown as string,
    })
    .onConflict((oc) =>
      oc.column("id").doUpdateSet({
        text: sql`EXCLUDED.text`,
        embedding: sql`EXCLUDED.embedding`,
        hash: sql`EXCLUDED.hash`,
        model: sql`EXCLUDED.model`,
        metadata: sql`EXCLUDED.metadata`,
        updated_at: sql`now()`,
      }),
    )
    .execute();
}

export async function searchMemoryByVector(
  userId: string,
  embedding: number[],
  limit: number = 10,
  category?: string,
): Promise<MemorySearchResult[]> {
  const db = getKysely();

  let query = db
    .selectFrom("memory_chunks")
    .select([
      "id",
      "text",
      "path",
      "source",
      cosineSimilarity("embedding", embedding).as("score"),
      "created_at",
      "access_count",
      "metadata",
    ])
    .where("user_id", "=", userId)
    .where("embedding", "is not", null)
    .orderBy(cosineDistance("embedding", embedding))
    .limit(limit);

  if (category) {
    query = query.where(sql`metadata->>'category'`, "=", category);
  }

  return query.execute() as unknown as Promise<MemorySearchResult[]>;
}

export async function searchMemoryByText(
  userId: string,
  query: string,
  limit: number = 10,
  category?: string,
): Promise<MemorySearchResult[]> {
  const db = getKysely();

  let q = db
    .selectFrom("memory_chunks")
    .select([
      "id",
      "text",
      "path",
      "source",
      ftsRank("text", query).as("score"),
      "created_at",
      "access_count",
      "metadata",
    ])
    .where("user_id", "=", userId)
    .where(ftsMatch("text", query))
    .orderBy("score", "desc")
    .limit(limit);

  if (category) {
    q = q.where(sql`metadata->>'category'`, "=", category);
  }

  return q.execute() as unknown as Promise<MemorySearchResult[]>;
}

export async function searchMemoryByCategory(
  userId: string,
  category: string,
  limit: number = 10,
): Promise<MemorySearchResult[]> {
  const db = getKysely();

  const rows = await db
    .selectFrom("memory_chunks")
    .select([
      "id",
      "text",
      "path",
      "source",
      sql<number>`1.0`.as("score"),
      "created_at",
      "access_count",
      "metadata",
    ])
    .where("user_id", "=", userId)
    .where(sql`metadata->>'category'`, "=", category)
    .orderBy("created_at", "desc")
    .limit(limit)
    .execute();
  return rows as unknown as MemorySearchResult[];
}

export async function updateMemoryMetadata(
  userId: string,
  id: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  const db = getKysely();
  const metadataJson = JSON.stringify(metadata);

  await db
    .updateTable("memory_chunks")
    .set({
      metadata: sql`metadata || ${metadataJson}::jsonb`,
      updated_at: sql`now()`,
    })
    .where("user_id", "=", userId)
    .where("id", "=", id)
    .execute();
}

/**
 * Record access to memory chunks (increment access_count, update last_accessed_at).
 * Called after search results are returned to the user. Scoped to the owner so a
 * shared chunk id can never bump another user's row.
 */
export async function recordMemoryAccess(userId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const db = getKysely();
  await db
    .updateTable("memory_chunks")
    .set({
      access_count: sql`access_count + 1`,
      last_accessed_at: sql`now()`,
    })
    .where("user_id", "=", userId)
    .where("id", "in", ids)
    .execute();
}

export async function deleteMemoryBySource(userId: string, source: string): Promise<number> {
  const db = getKysely();
  const result = await db
    .deleteFrom("memory_chunks")
    .where("user_id", "=", userId)
    .where("source", "=", source)
    .executeTakeFirst();
  return Number(result.numDeletedRows ?? 0n);
}

export async function deleteMemoryByPath(userId: string, path: string): Promise<number> {
  const db = getKysely();
  const result = await db
    .deleteFrom("memory_chunks")
    .where("user_id", "=", userId)
    .where("path", "=", path)
    .executeTakeFirst();
  return Number(result.numDeletedRows ?? 0n);
}

/**
 * Delete all chunks whose id starts with `prefix`. Used to remove a single
 * vault note's chunks by their deterministic, user-namespaced id prefix
 * (`vault:<hash(userId:path)>:`) so forgetting a note also forgets it from
 * vector recall. The prefix already encodes the user, but we also filter by
 * user_id as belt-and-suspenders.
 */
export async function deleteMemoryByIdPrefix(userId: string, prefix: string): Promise<number> {
  const db = getKysely();
  const result = await db
    .deleteFrom("memory_chunks")
    .where("user_id", "=", userId)
    .where("id", "like", `${prefix}%`)
    .executeTakeFirst();
  return Number(result.numDeletedRows ?? 0n);
}
