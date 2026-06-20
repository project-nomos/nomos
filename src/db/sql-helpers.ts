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

/**
 * Build an OR'd tsquery string from free text: "aisle seats" -> "aisle | seats".
 * Tokens are lowercased, reduced to alphanumerics, and 1-char tokens dropped, so
 * no punctuation reaches `to_tsquery` (which is strict and would throw on it).
 * `to_tsquery` still stems each token. Returns null when nothing usable remains
 * (caller falls back to `plainto_tsquery`). Postgres drops stop-word-only tokens
 * silently, so an all-stopword query degrades to an empty (matches-nothing) query.
 */
function orTsQuery(query: string): string | null {
  const usable = (query.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length > 1);
  return usable.length > 0 ? usable.join(" | ") : null;
}

/**
 * FTS match. Uses an OR of the query terms (`to_tsquery('a | b | c')`) instead of
 * `plainto_tsquery`'s AND-of-all-terms, so a single non-matching word ("which
 * AIRLINE do I fly" against a note that says "flies United") no longer vetoes an
 * otherwise-strong row. Precision is preserved by ranking, not by the match:
 * `ftsRank` still scores with the AND query, so rows that match every term rank
 * above the partial matches this OR now admits and win the top-k. Falls back to
 * `plainto_tsquery` when the query has no usable term.
 */
export function ftsMatch(column: string, query: string): RawBuilder<boolean> {
  const orQuery = orTsQuery(query);
  if (orQuery === null) {
    return sql<boolean>`to_tsvector('english', ${sql.ref(column)}) @@ plainto_tsquery('english', ${query})`;
  }
  return sql<boolean>`to_tsvector('english', ${sql.ref(column)}) @@ to_tsquery('english', ${orQuery})`;
}

/**
 * FTS rank: `ts_rank(to_tsvector('english', column), plainto_tsquery('english', query))`.
 * Deliberately keeps the AND (`plainto`) query: `ts_rank` scores by how many query
 * terms a row matches, so full matches rank above the partial matches `ftsMatch`'s
 * OR admits. This is what keeps OR-recall from costing precision in the top-k.
 */
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
