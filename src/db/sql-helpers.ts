/**
 * Typed raw SQL builders for operations Kysely can't express natively:
 * pgvector similarity, full-text search, and interval arithmetic.
 */

import { sql, type RawBuilder } from "kysely";

// ---------------------------------------------------------------------------
// pgvector
// ---------------------------------------------------------------------------

/** Cosine distance: `embedding <=> $vector` (lower = more similar). */
export function cosineDistance(column: string, embedding: number[]): RawBuilder<number> {
  const vec = `[${embedding.join(",")}]`;
  return sql<number>`${sql.ref(column)} <=> ${vec}`;
}

/** Cosine similarity: `1 - (embedding <=> $vector)`. */
export function cosineSimilarity(column: string, embedding: number[]): RawBuilder<number> {
  const vec = `[${embedding.join(",")}]`;
  return sql<number>`1 - (${sql.ref(column)} <=> ${vec})`;
}

// ---------------------------------------------------------------------------
// Full-text search
// ---------------------------------------------------------------------------

/** FTS match: `to_tsvector('english', column) @@ plainto_tsquery('english', query)`. */
export function ftsMatch(column: string, query: string): RawBuilder<boolean> {
  return sql<boolean>`to_tsvector('english', ${sql.ref(column)}) @@ plainto_tsquery('english', ${query})`;
}

/** FTS rank: `ts_rank(to_tsvector('english', column), plainto_tsquery('english', query))`. */
export function ftsRank(column: string, query: string): RawBuilder<number> {
  return sql<number>`ts_rank(to_tsvector('english', ${sql.ref(column)}), plainto_tsquery('english', ${query}))`;
}

// ---------------------------------------------------------------------------
// Interval helpers
// ---------------------------------------------------------------------------

/** PostgreSQL interval in days: `interval '$n days'`. */
export function intervalDays(days: number): RawBuilder<unknown> {
  return sql`${days.toString()} days::interval`;
}

/** PostgreSQL interval in hours: `interval '$n hours'`. */
export function intervalHours(hours: number): RawBuilder<unknown> {
  return sql`${hours.toString()} hours::interval`;
}

/** PostgreSQL interval from string: `'$str'::interval`. */
export function intervalStr(str: string): RawBuilder<unknown> {
  return sql`${str}::interval`;
}

// ---------------------------------------------------------------------------
// JSONB helpers
// ---------------------------------------------------------------------------

/** Cast a value to JSONB: `$value::jsonb`. */
export function jsonbValue(value: unknown): RawBuilder<unknown> {
  return sql`${JSON.stringify(value)}::jsonb`;
}
