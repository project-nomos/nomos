/**
 * Communication style model.
 *
 * Analyzes the user's sent messages (from ingested data) to extract
 * a writing style profile — globally and per contact.
 *
 * Uses a forked agent (Haiku) to analyze message samples and extract
 * style characteristics: formality, length, emoji usage, vocabulary, etc.
 */

import { sql, type Kysely } from "kysely";
import { z } from "zod";
import { getKysely } from "../db/client.ts";
import { runReasoningFork } from "../sdk/reasoning-fork.ts";
import { upsertStyleProfile, type StyleProfile } from "../db/style-profiles.ts";
import type { Database } from "../db/types.ts";

const MAX_SAMPLES_PER_ANALYSIS = 100;
const MAX_CONTACTS_PER_BATCH = 50;

interface MessageSample {
  contact: string;
  contactName: string | null;
  content: string;
  timestamp: string;
}

/**
 * STABLE rubric + JSON-shape spec for the style analysis fork. Byte-identical
 * across every call so the SDK caches it in the system-prompt prefix; only the
 * per-batch SAMPLES (the dynamic `input`) are billed uncached.
 */
const STYLE_INSTRUCTIONS = `Analyze the writing samples in the user prompt and extract a communication style profile.

Return a JSON object with EXACTLY these fields:
{
  "formality": <number 1-5, 1=very casual, 5=very formal>,
  "avgLength": <average message length in words>,
  "emojiUsage": <"none"|"rare"|"moderate"|"frequent">,
  "punctuation": <"minimal"|"standard"|"expressive">,
  "greetingStyle": <typical greeting or "none">,
  "signoffStyle": <typical sign-off or "none">,
  "vocabulary": [<5-10 characteristic words/phrases>],
  "tone": <"direct"|"warm"|"professional"|"playful"|"neutral">,
  "casing": <"lowercase"|"standard"|"mixed">,
  "responseSpeed": <"brief"|"moderate"|"detailed">
}

Return ONLY the JSON, no explanation.`;

/**
 * Mirrors {@link StyleProfile} exactly. Defaults let a partial emit still
 * validate (mirroring extractor.ts) — but a fork that yields nothing parseable
 * returns null (see coerceStructuredOutput), and we SKIP the DB write rather
 * than persist a synthetic profile.
 */
const StyleProfileSchema = z.object({
  formality: z.number().default(3),
  avgLength: z.number().default(20),
  emojiUsage: z.enum(["none", "rare", "moderate", "frequent"]).default("rare"),
  punctuation: z.string().default("standard"),
  greetingStyle: z.string().default("none"),
  signoffStyle: z.string().default("none"),
  vocabulary: z.array(z.string()).default([]),
  tone: z.string().default("neutral"),
  casing: z.string().default("standard"),
  responseSpeed: z.string().default("moderate"),
}) satisfies z.ZodType<StyleProfile>;

/**
 * In-memory fallback for {@link analyzeStyle}'s return value ONLY when the global
 * fork yields nothing parseable. Never written to style_profiles — the DB write
 * is skipped in that case (see analyzeStyle) so we don't persist a synthetic row.
 */
const DEFAULT_STYLE_PROFILE: StyleProfile = {
  formality: 3,
  avgLength: 20,
  emojiUsage: "rare",
  punctuation: "standard",
  greetingStyle: "none",
  signoffStyle: "none",
  vocabulary: [],
  tone: "neutral",
  casing: "standard",
  responseSpeed: "moderate",
};

/**
 * Analyze style from ingested sent messages.
 * Creates a global profile and per-contact profiles.
 */
export async function analyzeStyle(userId: string): Promise<{
  globalProfile: StyleProfile;
  contactProfiles: number;
}> {
  const db = getKysely();

  // Fetch sent messages grouped by contact (owner-scoped)
  const contacts = await db
    .selectFrom("memory_chunks")
    .select([
      sql<string>`metadata->>'contact'`.as("contact"),
      sql<number>`COUNT(*)::int`.as("count"),
    ])
    .where("user_id", "=", userId)
    .where(sql`metadata->>'source'`, "=", "ingest")
    .where(sql`metadata->>'direction'`, "=", "sent")
    .where(sql`metadata->>'contact'`, "is not", null)
    .groupBy(sql`metadata->>'contact'`)
    .orderBy("count", "desc")
    .limit(MAX_CONTACTS_PER_BATCH)
    .execute();

  // Fetch global sample for overall style. If the fork yields no valid profile,
  // SKIP the write — never persist a synthetic default to style_profiles.
  const globalSamples = await fetchSamples(db, userId, null);
  const globalProfile = await extractStyleProfile(globalSamples, "global");
  if (globalProfile) {
    await upsertStyleProfile(userId, null, "global", globalProfile, globalSamples.length);
  }

  // Per-contact profiles
  let contactCount = 0;
  for (const { contact } of contacts) {
    if (!contact) continue;
    const samples = await fetchSamples(db, userId, contact);
    if (samples.length < 5) continue; // Need minimum samples

    const profile = await extractStyleProfile(samples, contact);
    if (!profile) continue; // No valid profile → skip write, don't persist a default.
    // Scoped to the owner; the contact lives in `scope` (contact_id FK is added
    // when the identity graph supplies a stable id).
    await upsertStyleProfile(userId, null, `contact:${contact}`, profile, samples.length);
    contactCount++;
  }

  // Preserve the public return shape: the caller always gets a StyleProfile.
  // A null here means the write was skipped, so return an in-memory default
  // (NOT persisted) rather than change the signature.
  return { globalProfile: globalProfile ?? DEFAULT_STYLE_PROFILE, contactProfiles: contactCount };
}

async function fetchSamples(
  db: Kysely<Database>,
  userId: string,
  contact: string | null,
): Promise<MessageSample[]> {
  let query = db
    .selectFrom("memory_chunks")
    .select([
      sql<string>`metadata->>'contact'`.as("contact"),
      sql<string | null>`metadata->>'contactName'`.as("contactName"),
      sql<string>`text`.as("content"),
      sql<string>`metadata->>'timestamp'`.as("timestamp"),
    ])
    .where("user_id", "=", userId)
    .where(sql`metadata->>'source'`, "=", "ingest")
    .where(sql`metadata->>'direction'`, "=", "sent");

  if (contact) {
    query = query.where(sql`metadata->>'contact'`, "=", contact).orderBy("created_at", "desc");
  } else {
    query = query.orderBy(sql`RANDOM()`);
  }

  return query.limit(MAX_SAMPLES_PER_ANALYSIS).execute() as unknown as Promise<MessageSample[]>;
}

/**
 * Analyze one batch of samples into a style profile. Returns null when the fork
 * yields nothing parseable — callers SKIP the DB write in that case (never
 * persist a synthetic default). The stable rubric/JSON-shape spec lives in
 * STYLE_INSTRUCTIONS (cached prefix); only the SAMPLES are the dynamic input.
 */
async function extractStyleProfile(
  samples: MessageSample[],
  label: string,
): Promise<StyleProfile | null> {
  const sampleText = samples
    .map((s) => s.content)
    .join("\n---\n")
    .slice(0, 8000);

  const { data } = await runReasoningFork({
    instructions: STYLE_INSTRUCTIONS,
    input: `SAMPLES:\n${sampleText}`,
    schema: StyleProfileSchema,
    label: `style-analysis:${label}`,
  });

  return data;
}
