/**
 * CRUD operations for the style_profiles table.
 *
 * Style profiles capture the user's writing voice — globally and per contact.
 */

import { sql } from "kysely";
import { getKysely } from "./client.ts";

export interface StyleProfileRow {
  id: string;
  user_id: string;
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
  userId: string,
  contactId: string | null,
  scope: string,
  profile: StyleProfile,
  sampleCount: number,
): Promise<StyleProfileRow> {
  const db = getKysely();

  const row = await db
    .insertInto("style_profiles")
    .values({
      user_id: userId,
      contact_id: contactId,
      scope,
      // Pass the OBJECT (driver serializes to jsonb once). JSON.stringify here
      // would double-encode into a jsonb string, so consumers reading
      // row.profile.formality would get undefined.
      profile: profile as unknown as string,
      sample_count: sampleCount,
      last_updated: sql`now()`,
    })
    .onConflict((oc) =>
      oc.columns(["user_id", "scope"]).doUpdateSet({
        profile: profile as unknown as string,
        sample_count: sampleCount,
        last_updated: sql`now()`,
      }),
    )
    .returningAll()
    .executeTakeFirstOrThrow();
  return row as unknown as StyleProfileRow;
}

export async function getStyleProfile(
  userId: string,
  scope: string = "global",
): Promise<StyleProfileRow | null> {
  const db = getKysely();
  const row = await db
    .selectFrom("style_profiles")
    .selectAll()
    .where("user_id", "=", userId)
    .where("scope", "=", scope)
    .executeTakeFirst();
  return (row as unknown as StyleProfileRow) ?? null;
}

export async function getGlobalStyleProfile(userId: string): Promise<StyleProfileRow | null> {
  return getStyleProfile(userId, "global");
}

export async function listStyleProfiles(userId: string): Promise<StyleProfileRow[]> {
  const db = getKysely();
  const rows = await db
    .selectFrom("style_profiles")
    .selectAll()
    .where("user_id", "=", userId)
    .orderBy("scope")
    .execute();
  return rows as unknown as StyleProfileRow[];
}

export async function deleteStyleProfile(id: string): Promise<void> {
  const db = getKysely();
  await db.deleteFrom("style_profiles").where("id", "=", id).execute();
}
