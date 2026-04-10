/**
 * Relationship metadata for contacts.
 *
 * Tracks the user's relationship with each contact:
 * role, frequency, topics, and interaction history.
 */

import { sql } from "kysely";
import { getKysely } from "../db/client.ts";

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
  const db = getKysely();
  const dataJson = JSON.stringify(data);

  await db
    .updateTable("contacts")
    .set({
      relationship: sql`relationship || ${dataJson}::jsonb`,
      updated_at: sql`now()`,
    })
    .where("id", "=", contactId)
    .execute();
}

export async function getRelationship(contactId: string): Promise<RelationshipData | null> {
  const db = getKysely();
  const row = await db
    .selectFrom("contacts")
    .select("relationship")
    .where("id", "=", contactId)
    .executeTakeFirst();
  if (!row) return null;
  return row.relationship as unknown as RelationshipData;
}

/**
 * Compute relationship stats from ingested messages.
 */
export async function computeRelationshipStats(
  contactId: string,
): Promise<RelationshipData | null> {
  const db = getKysely();

  // Get all identities for this contact
  const identities = await db
    .selectFrom("contact_identities")
    .select("platform_user_id")
    .where("contact_id", "=", contactId)
    .execute();

  if (identities.length === 0) return null;

  const userIds = identities.map((i) => i.platform_user_id);

  const stats = await db
    .selectFrom("memory_chunks")
    .select([
      sql<number>`COUNT(*)::int`.as("msg_count"),
      sql<string | null>`MIN(metadata->>'timestamp')`.as("first_msg"),
      sql<string | null>`MAX(metadata->>'timestamp')`.as("last_msg"),
    ])
    .where(sql`metadata->>'source'`, "=", "ingest")
    .where(sql`metadata->>'contact'`, "=", sql`ANY(${userIds})`)
    .executeTakeFirst();

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
