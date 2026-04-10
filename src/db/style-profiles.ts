/**
 * CRUD operations for the style_profiles table.
 *
 * Style profiles capture the user's writing voice — globally and per contact.
 */

import { sql, type SqlBool } from "kysely";
import { getKysely } from "./client.ts";

export interface StyleProfileRow {
  id: string;
  contact_id: string | null;
  scope: string;
  profile: Record<string, unknown>;
  sample_count: number;
  last_updated: Date;
  created_at: Date;
}

export interface StyleProfile {
  formality: number; // 1 (very casual) to 5 (very formal)
  avgLength: number; // average message length in words
  emojiUsage: "none" | "rare" | "moderate" | "frequent";
  punctuation: string; // e.g., "minimal", "standard", "expressive"
  greetingStyle: string; // e.g., "hey", "hi", "hello", "none"
  signoffStyle: string; // e.g., "thanks", "cheers", "none"
  vocabulary: string[]; // characteristic words/phrases
  tone: string; // e.g., "direct", "warm", "professional", "playful"
  casing: string; // e.g., "lowercase", "standard", "mixed"
  responseSpeed: string; // e.g., "brief", "moderate", "detailed"
}

export async function upsertStyleProfile(
  contactId: string | null,
  scope: string,
  profile: StyleProfile,
  sampleCount: number,
): Promise<StyleProfileRow> {
  const db = getKysely();
  const profileJson = JSON.stringify(profile);

  const row = await db
    .insertInto("style_profiles")
    .values({
      contact_id: contactId,
      scope,
      profile: profileJson,
      sample_count: sampleCount,
      last_updated: sql`now()`,
    })
    .onConflict((oc) =>
      oc.columns(["contact_id", "scope"]).doUpdateSet({
        profile: sql`${profileJson}::jsonb`,
        sample_count: sampleCount,
        last_updated: sql`now()`,
      }),
    )
    .returningAll()
    .executeTakeFirstOrThrow();
  return row as unknown as StyleProfileRow;
}

export async function getStyleProfile(
  contactId: string | null,
  scope: string = "global",
): Promise<StyleProfileRow | null> {
  const db = getKysely();
  const row = await db
    .selectFrom("style_profiles")
    .selectAll()
    .where(sql<SqlBool>`contact_id IS NOT DISTINCT FROM ${contactId}`)
    .where("scope", "=", scope)
    .executeTakeFirst();
  return (row as unknown as StyleProfileRow) ?? null;
}

export async function getGlobalStyleProfile(): Promise<StyleProfileRow | null> {
  return getStyleProfile(null, "global");
}

export async function listStyleProfiles(): Promise<StyleProfileRow[]> {
  const db = getKysely();
  const rows = await db
    .selectFrom("style_profiles")
    .selectAll()
    .orderBy("scope")
    .orderBy(sql`contact_id NULLS FIRST`)
    .execute();
  return rows as unknown as StyleProfileRow[];
}

export async function deleteStyleProfile(id: string): Promise<void> {
  const db = getKysely();
  await db.deleteFrom("style_profiles").where("id", "=", id).execute();
}
