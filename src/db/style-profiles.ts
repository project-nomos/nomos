/**
 * CRUD operations for the style_profiles table.
 *
 * Style profiles capture the user's writing voice — globally and per contact.
 */

import { getDb } from "./client.ts";

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
  const sql = getDb();
  const profileJson = JSON.stringify(profile);

  const [row] = await sql<StyleProfileRow[]>`
    INSERT INTO style_profiles (contact_id, scope, profile, sample_count, last_updated)
    VALUES (${contactId}, ${scope}, ${profileJson}::jsonb, ${sampleCount}, now())
    ON CONFLICT (contact_id, scope)
    DO UPDATE SET
      profile = ${profileJson}::jsonb,
      sample_count = ${sampleCount},
      last_updated = now()
    RETURNING *
  `;
  return row;
}

export async function getStyleProfile(
  contactId: string | null,
  scope: string = "global",
): Promise<StyleProfileRow | null> {
  const sql = getDb();
  const rows = await sql<StyleProfileRow[]>`
    SELECT * FROM style_profiles
    WHERE contact_id IS NOT DISTINCT FROM ${contactId}
      AND scope = ${scope}
  `;
  return rows[0] ?? null;
}

export async function getGlobalStyleProfile(): Promise<StyleProfileRow | null> {
  return getStyleProfile(null, "global");
}

export async function listStyleProfiles(): Promise<StyleProfileRow[]> {
  const sql = getDb();
  return sql<StyleProfileRow[]>`
    SELECT * FROM style_profiles
    ORDER BY scope, contact_id NULLS FIRST
  `;
}

export async function deleteStyleProfile(id: string): Promise<void> {
  const sql = getDb();
  await sql`DELETE FROM style_profiles WHERE id = ${id}`;
}
