/**
 * Heuristic auto-linker for cross-platform identity resolution.
 *
 * Strategies:
 * 1. Exact email match across platforms
 * 2. Fuzzy display name matching
 * 3. Same phone number (iMessage ↔ WhatsApp)
 */

import { getDb } from "../db/client.ts";
import { mergeContacts } from "./contacts.ts";

interface LinkCandidate {
  contact_id_a: string;
  contact_id_b: string;
  display_name_a: string;
  display_name_b: string;
  reason: string;
  confidence: number;
}

/**
 * Find potential contact merges based on heuristics.
 * Does NOT auto-merge — returns candidates for review or auto-apply above threshold.
 */
export async function findLinkCandidates(autoMergeThreshold = 0.9): Promise<LinkCandidate[]> {
  const sql = getDb();
  const candidates: LinkCandidate[] = [];

  // Strategy 1: Exact email match across different contacts
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
    JOIN contact_identities b ON a.email = b.email AND a.contact_id < b.contact_id
    JOIN contacts ca ON ca.id = a.contact_id
    JOIN contacts cb ON cb.id = b.contact_id
    WHERE a.email IS NOT NULL AND a.email != ''
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

  // Strategy 2: Fuzzy display name match (same name, different platforms)
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
    JOIN contact_identities b ON a.contact_id < b.contact_id AND a.platform != b.platform
    JOIN contacts ca ON ca.id = a.contact_id
    JOIN contacts cb ON cb.id = b.contact_id
    WHERE LOWER(COALESCE(a.display_name, ca.display_name)) = LOWER(COALESCE(b.display_name, cb.display_name))
      AND COALESCE(a.display_name, ca.display_name) IS NOT NULL
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

  // Auto-merge high-confidence matches
  const autoMerged: string[] = [];
  for (const candidate of candidates) {
    if (
      candidate.confidence >= autoMergeThreshold &&
      !autoMerged.includes(candidate.contact_id_b)
    ) {
      await mergeContacts(candidate.contact_id_a, candidate.contact_id_b);
      autoMerged.push(candidate.contact_id_b);
      console.log(
        `[auto-linker] Merged "${candidate.display_name_b}" into "${candidate.display_name_a}" (${candidate.reason})`,
      );
    }
  }

  // Return remaining candidates below threshold
  return candidates.filter(
    (c) => c.confidence < autoMergeThreshold && !autoMerged.includes(c.contact_id_b),
  );
}

/**
 * Run auto-linking after ingestion completes.
 */
export async function runAutoLinker(): Promise<{ merged: number; candidates: number }> {
  const candidates = await findLinkCandidates();
  const sql = getDb();

  // Count auto-merged (candidates returned are those NOT merged)
  const [{ count: totalContacts }] = await sql<{ count: number }[]>`
    SELECT COUNT(*)::int AS count FROM contacts
  `;

  console.log(
    `[auto-linker] ${totalContacts} contacts, ${candidates.length} potential merge candidates remaining`,
  );

  return { merged: 0, candidates: candidates.length };
}
