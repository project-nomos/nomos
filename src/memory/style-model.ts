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
import { getKysely } from "../db/client.ts";
import { runForkedAgent } from "../sdk/forked-agent.ts";
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
 * Analyze style from ingested sent messages.
 * Creates a global profile and per-contact profiles.
 */
export async function analyzeStyle(): Promise<{
  globalProfile: StyleProfile;
  contactProfiles: number;
}> {
  const db = getKysely();

  // Fetch sent messages grouped by contact
  const contacts = await db
    .selectFrom("memory_chunks")
    .select([
      sql<string>`metadata->>'contact'`.as("contact"),
      sql<number>`COUNT(*)::int`.as("count"),
    ])
    .where(sql`metadata->>'source'`, "=", "ingest")
    .where(sql`metadata->>'direction'`, "=", "sent")
    .where(sql`metadata->>'contact'`, "is not", null)
    .groupBy(sql`metadata->>'contact'`)
    .orderBy("count", "desc")
    .limit(MAX_CONTACTS_PER_BATCH)
    .execute();

  // Fetch global sample for overall style
  const globalSamples = await fetchSamples(db, null);
  const globalProfile = await extractStyleProfile(globalSamples, "global");
  await upsertStyleProfile(null, "global", globalProfile, globalSamples.length);

  // Per-contact profiles
  let contactCount = 0;
  for (const { contact } of contacts) {
    if (!contact) continue;
    const samples = await fetchSamples(db, contact);
    if (samples.length < 5) continue; // Need minimum samples

    const profile = await extractStyleProfile(samples, contact);
    // Store with contact identifier (contact_id FK added when identity graph exists)
    await upsertStyleProfile(null, `contact:${contact}`, profile, samples.length);
    contactCount++;
  }

  return { globalProfile, contactProfiles: contactCount };
}

async function fetchSamples(
  db: Kysely<Database>,
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
    .where(sql`metadata->>'source'`, "=", "ingest")
    .where(sql`metadata->>'direction'`, "=", "sent");

  if (contact) {
    query = query.where(sql`metadata->>'contact'`, "=", contact).orderBy("created_at", "desc");
  } else {
    query = query.orderBy(sql`RANDOM()`);
  }

  return query.limit(MAX_SAMPLES_PER_ANALYSIS).execute() as unknown as Promise<MessageSample[]>;
}

async function extractStyleProfile(samples: MessageSample[], label: string): Promise<StyleProfile> {
  const sampleText = samples
    .map((s) => s.content)
    .join("\n---\n")
    .slice(0, 8000);

  const prompt = `Analyze these writing samples and extract a communication style profile.

SAMPLES:
${sampleText}

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

  const result = await runForkedAgent({
    prompt,
    label: `style-analysis:${label}`,
  });

  try {
    const jsonMatch = result.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON found in response");
    return JSON.parse(jsonMatch[0]) as StyleProfile;
  } catch {
    // Return defaults if parsing fails
    return {
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
  }
}
