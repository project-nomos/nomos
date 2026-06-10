/**
 * Twin-test fidelity score history -- each /twin-test run records the fraction of
 * pairs the discriminator was fooled, so "/twin-test score" shows the trend.
 * Per-owner; the DB is the source of truth (no on-disk score file).
 */

import { getKysely } from "./client.ts";

export interface FidelityScoreRow {
  id: string;
  userId: string;
  score: number;
  pairs: number;
  fooled: number;
  detail: unknown;
  createdAt: Date;
}

export async function recordFidelityScore(entry: {
  userId: string;
  score: number;
  pairs: number;
  fooled: number;
  detail?: unknown;
}): Promise<void> {
  const db = getKysely();
  await db
    .insertInto("fidelity_scores")
    .values({
      user_id: entry.userId,
      score: entry.score,
      pairs: entry.pairs,
      fooled: entry.fooled,
      // object passthrough -> jsonb (JSON.stringify would double-encode)
      ...(entry.detail !== undefined ? { detail: entry.detail as unknown as string } : {}),
    })
    .execute();
}

export async function getFidelityHistory(userId: string, limit = 20): Promise<FidelityScoreRow[]> {
  const db = getKysely();
  const rows = await db
    .selectFrom("fidelity_scores")
    .selectAll()
    .where("user_id", "=", userId)
    .orderBy("created_at", "desc")
    .limit(limit)
    .execute();
  return rows.map((r) => ({
    id: r.id,
    userId: r.user_id,
    score: r.score,
    pairs: r.pairs,
    fooled: r.fooled,
    detail: r.detail,
    createdAt: r.created_at,
  }));
}
