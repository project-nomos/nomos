/**
 * Heuristic auto-linker for cross-platform identity resolution.
 *
 * Strategies:
 * 1. Exact email match across platforms
 * 2. Fuzzy display name matching
 * 3. Same phone number (iMessage ↔ WhatsApp)
 *
 * Every candidate query and merge is scoped to ONE owner (`userId`). Without this
 * the cross-contact JOINs would match (and auto-merge) contacts belonging to
 * DIFFERENT users in a shared DB, destroying one member's data into another's.
 */

import { getDb } from "../db/client.ts";
import { mergeContacts } from "./contacts.ts";
import { createLogger } from "../lib/logger.ts";

const log = createLogger("auto-linker");

interface LinkCandidate {
  contact_id_a: string;
  contact_id_b: string;
  display_name_a: string;
  display_name_b: string;
  reason: string;
  confidence: number;
}

/**
 * Find potential contact merges based on heuristics, for one owner.
 * Auto-merges high-confidence matches within that owner's contacts only.
 */
export async function findLinkCandidates(
  userId: string,
  autoMergeThreshold = 0.9,
): Promise<LinkCandidate[]> {
  const sql = getDb();
  const candidates: LinkCandidate[] = [];

  // Strategy 1: Exact email match across different contacts (same owner only)
  const emailMatches = await sql<
    {
      email: string;
      contact_id_a: string;
      contact_id_b: string;
      name_a: string;
      name_b: string;
    }[]
  >`
    SELECT
      a.email,
      a.contact_id AS contact_id_a,
      b.contact_id AS contact_id_b,
      ca.display_name AS name_a,
      cb.display_name AS name_b
    FROM contact_identities a
    JOIN contact_identities b
      ON a.email = b.email AND a.contact_id < b.contact_id AND a.user_id = b.user_id
    JOIN contacts ca ON ca.id = a.contact_id
    JOIN contacts cb ON cb.id = b.contact_id
    WHERE a.email IS NOT NULL AND a.email != '' AND a.user_id = ${userId}
  `;

  for (const match of emailMatches) {
    candidates.push({
      contact_id_a: match.contact_id_a,
      contact_id_b: match.contact_id_b,
      display_name_a: match.name_a,
      display_name_b: match.name_b,
      reason: `Shared email: ${match.email}`,
      confidence: 0.95,
    });
  }

  // Strategy 2: Fuzzy display name match (same name, different platforms; same owner)
  const nameMatches = await sql<
    {
      contact_id_a: string;
      contact_id_b: string;
      name_a: string;
      name_b: string;
      platform_a: string;
      platform_b: string;
    }[]
  >`
    SELECT DISTINCT
      a.contact_id AS contact_id_a,
      b.contact_id AS contact_id_b,
      ca.display_name AS name_a,
      cb.display_name AS name_b,
      a.platform AS platform_a,
      b.platform AS platform_b
    FROM contact_identities a
    JOIN contact_identities b
      ON a.contact_id < b.contact_id AND a.platform != b.platform AND a.user_id = b.user_id
    JOIN contacts ca ON ca.id = a.contact_id
    JOIN contacts cb ON cb.id = b.contact_id
    WHERE LOWER(COALESCE(a.display_name, ca.display_name)) = LOWER(COALESCE(b.display_name, cb.display_name))
      AND COALESCE(a.display_name, ca.display_name) IS NOT NULL
      AND a.user_id = ${userId}
  `;

  for (const match of nameMatches) {
    candidates.push({
      contact_id_a: match.contact_id_a,
      contact_id_b: match.contact_id_b,
      display_name_a: match.name_a,
      display_name_b: match.name_b,
      reason: `Same name across ${match.platform_a} and ${match.platform_b}`,
      confidence: 0.7,
    });
  }

  // Auto-merge high-confidence matches (owner-scoped at the data layer too)
  const autoMerged: string[] = [];
  for (const candidate of candidates) {
    if (
      candidate.confidence >= autoMergeThreshold &&
      !autoMerged.includes(candidate.contact_id_b)
    ) {
      await mergeContacts(userId, candidate.contact_id_a, candidate.contact_id_b);
      autoMerged.push(candidate.contact_id_b);
      log.info(
        {
          from: candidate.display_name_b,
          into: candidate.display_name_a,
          reason: candidate.reason,
        },
        "Merged contact",
      );
    }
  }

  // Return remaining candidates below threshold
  return candidates.filter(
    (c) => c.confidence < autoMergeThreshold && !autoMerged.includes(c.contact_id_b),
  );
}

/**
 * Run auto-linking after ingestion completes, for one owner.
 */
export async function runAutoLinker(
  userId: string,
): Promise<{ merged: number; candidates: number }> {
  const candidates = await findLinkCandidates(userId);
  const sql = getDb();

  // Count auto-merged (candidates returned are those NOT merged)
  const [{ count: totalContacts }] = await sql<{ count: number }[]>`
    SELECT COUNT(*)::int AS count FROM contacts WHERE user_id = ${userId}
  `;

  log.info(
    { totalContacts, candidates: candidates.length },
    "Contacts and potential merge candidates remaining",
  );

  return { merged: 0, candidates: candidates.length };
}
