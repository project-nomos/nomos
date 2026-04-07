/**
 * Relationship metadata for contacts.
 *
 * Tracks the user's relationship with each contact:
 * role, frequency, topics, and interaction history.
 */

import { getDb } from "../db/client.ts";

export interface RelationshipData {
  role?: string; // colleague, friend, family, client, manager, etc.
  company?: string;
  frequency?: "daily" | "weekly" | "monthly" | "rare";
  topics?: string[];
  firstContact?: string; // ISO date
  lastContact?: string; // ISO date
  messageCount?: number;
}

export async function updateRelationship(contactId: string, data: RelationshipData): Promise<void> {
  const sql = getDb();
  const dataJson = JSON.stringify(data);

  await sql`
    UPDATE contacts
    SET relationship = relationship || ${dataJson}::jsonb,
        updated_at = now()
    WHERE id = ${contactId}
  `;
}

export async function getRelationship(contactId: string): Promise<RelationshipData | null> {
  const sql = getDb();
  const rows = await sql<{ relationship: Record<string, unknown> }[]>`
    SELECT relationship FROM contacts WHERE id = ${contactId}
  `;
  if (rows.length === 0) return null;
  return rows[0].relationship as RelationshipData;
}

/**
 * Compute relationship stats from ingested messages.
 */
export async function computeRelationshipStats(
  contactId: string,
): Promise<RelationshipData | null> {
  const sql = getDb();

  // Get all identities for this contact
  const identities = await sql<{ platform_user_id: string }[]>`
    SELECT platform_user_id FROM contact_identities WHERE contact_id = ${contactId}
  `;

  if (identities.length === 0) return null;

  const userIds = identities.map((i) => i.platform_user_id);

  const [stats] = await sql<
    {
      msg_count: number;
      first_msg: string | null;
      last_msg: string | null;
    }[]
  >`
    SELECT
      COUNT(*)::int AS msg_count,
      MIN(metadata->>'timestamp') AS first_msg,
      MAX(metadata->>'timestamp') AS last_msg
    FROM memory_chunks
    WHERE metadata->>'source' = 'ingest'
      AND metadata->>'contact' = ANY(${userIds})
  `;

  if (!stats || stats.msg_count === 0) return null;

  // Determine frequency from message count and date range
  let frequency: RelationshipData["frequency"] = "rare";
  if (stats.first_msg && stats.last_msg) {
    const days =
      (new Date(stats.last_msg).getTime() - new Date(stats.first_msg).getTime()) /
      (1000 * 60 * 60 * 24);
    const msgsPerDay = days > 0 ? stats.msg_count / days : 0;
    if (msgsPerDay > 1) frequency = "daily";
    else if (msgsPerDay > 0.15) frequency = "weekly";
    else if (msgsPerDay > 0.03) frequency = "monthly";
  }

  return {
    frequency,
    firstContact: stats.first_msg ?? undefined,
    lastContact: stats.last_msg ?? undefined,
    messageCount: stats.msg_count,
  };
}
