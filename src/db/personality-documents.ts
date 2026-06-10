/**
 * Personality documents store -- the DB is the source of truth for the "Think
 * Like You" documents (personality DNA, shadow-mode observations), replacing the
 * old ~/.nomos/*.json files. Singleton per (owner, kind), wiki-pattern upsert.
 */

import { sql } from "kysely";
import { getKysely } from "./client.ts";

export type PersonalityDocumentKind = "dna" | "shadow_observations";

/** Upsert the single document for (userId, kind). Pass the OBJECT so the driver
 * serializes to jsonb once (JSON.stringify would double-encode into a string). */
export async function upsertPersonalityDocument(
  userId: string,
  kind: PersonalityDocumentKind,
  content: unknown,
): Promise<void> {
  const db = getKysely();
  await db
    .insertInto("personality_documents")
    .values({ user_id: userId, kind, content: content as unknown as string })
    .onConflict((oc) =>
      oc.columns(["user_id", "kind"]).doUpdateSet({
        content: sql`excluded.content`,
        updated_at: sql`now()`,
      }),
    )
    .execute();
}

/** Read the document for (userId, kind), or null. */
export async function getPersonalityDocument<T = unknown>(
  userId: string,
  kind: PersonalityDocumentKind,
): Promise<T | null> {
  const db = getKysely();
  const row = await db
    .selectFrom("personality_documents")
    .select("content")
    .where("user_id", "=", userId)
    .where("kind", "=", kind)
    .executeTakeFirst();
  return row ? (row.content as T) : null;
}
