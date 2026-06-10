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

export async function updateRelationship(
  userId: string,
  contactId: string,
  data: RelationshipData,
): Promise<void> {
  const db = getKysely();

  await db
    .updateTable("contacts")
    .set({
      // Pass the OBJECT (the driver serializes to jsonb once). JSON.stringify here
      // double-encodes into a jsonb STRING, and `relationship || "<string>"`
      // produces an ARRAY [{}, "..."] instead of a merged object.
      relationship: sql`relationship || ${data as unknown as string}::jsonb`,
      updated_at: sql`now()`,
    })
    .where("user_id", "=", userId)
    .where("id", "=", contactId)
    .execute();
}

/**
 * Build the relationship patch for one inbound interaction. Pure (no DB) so the
 * shape is unit-testable: stamps lastContact, bumps the message count, records
 * firstContact on the first touch, and folds in any role/company the channel knew.
 */
export function buildInboundRelationship(opts: {
  created: boolean;
  priorMessageCount: number;
  nowIso: string;
  role?: string;
  company?: string;
}): RelationshipData {
  return {
    lastContact: opts.nowIso,
    messageCount: opts.priorMessageCount + 1,
    ...(opts.created ? { firstContact: opts.nowIso } : {}),
    ...(opts.role ? { role: opts.role } : {}),
    ...(opts.company ? { company: opts.company } : {}),
  };
}

/**
 * Enrich a contact's relationship on resolution: refresh interaction stats and
 * fold in any role/company. This is what wires the relationship subsystem onto
 * the live inbound identity path (it was dormant -- the column stayed '{}').
 */
export async function enrichContactRelationship(
  userId: string,
  contactId: string,
  opts: { created: boolean; role?: string; company?: string; nowIso?: string },
): Promise<void> {
  const current = opts.created ? null : await getRelationship(userId, contactId);
  const patch = buildInboundRelationship({
    created: opts.created,
    priorMessageCount: current?.messageCount ?? 0,
    nowIso: opts.nowIso ?? new Date().toISOString(),
    role: opts.role,
    company: opts.company,
  });
  await updateRelationship(userId, contactId, patch);
}

export async function getRelationship(
  userId: string,
  contactId: string,
): Promise<RelationshipData | null> {
  const db = getKysely();
  const row = await db
    .selectFrom("contacts")
    .select("relationship")
    .where("user_id", "=", userId)
    .where("id", "=", contactId)
    .executeTakeFirst();
  if (!row) return null;
  return row.relationship as unknown as RelationshipData;
}

/**
 * Bucket a contact into a contact frequency from message volume over the span of
 * the relationship. Pure (no DB) so the thresholds are unit-testable.
 */
export function frequencyFromStats(
  msgCount: number,
  firstMsg: string | null,
  lastMsg: string | null,
): RelationshipData["frequency"] {
  if (!firstMsg || !lastMsg) return "rare";
  const days = (new Date(lastMsg).getTime() - new Date(firstMsg).getTime()) / (1000 * 60 * 60 * 24);
  const msgsPerDay = days > 0 ? msgCount / days : 0;
  if (msgsPerDay > 1) return "daily";
  if (msgsPerDay > 0.15) return "weekly";
  if (msgsPerDay > 0.03) return "monthly";
  return "rare";
}

/**
 * Compute relationship stats from ingested messages.
 */
export async function computeRelationshipStats(
  userId: string,
  contactId: string,
): Promise<RelationshipData | null> {
  const db = getKysely();

  // Get all identities for this contact (owner-scoped)
  const identities = await db
    .selectFrom("contact_identities")
    .select("platform_user_id")
    .where("user_id", "=", userId)
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
    .where("user_id", "=", userId)
    .where(sql`metadata->>'source'`, "=", "ingest")
    .where(sql`metadata->>'contact'`, "=", sql`ANY(${userIds})`)
    .executeTakeFirst();

  if (!stats || stats.msg_count === 0) return null;

  return {
    frequency: frequencyFromStats(stats.msg_count, stats.first_msg, stats.last_msg),
    firstContact: stats.first_msg ?? undefined,
    lastContact: stats.last_msg ?? undefined,
    messageCount: stats.msg_count,
  };
}

/**
 * Refresh every contact's relationship stats from the owner's ingested history.
 * Wires computeRelationshipStats onto a live path (post-ingestion): a contact
 * with ingested messages gets its frequency + message count merged into the
 * relationship jsonb. Best-effort and owner-scoped; returns how many were updated.
 */
export async function refreshRelationshipStats(userId: string): Promise<number> {
  const db = getKysely();
  const contacts = await db
    .selectFrom("contacts")
    .select("id")
    .where("user_id", "=", userId)
    .execute();

  let updated = 0;
  for (const c of contacts) {
    const stats = await computeRelationshipStats(userId, c.id);
    if (stats) {
      await updateRelationship(userId, c.id, stats);
      updated++;
    }
  }
  return updated;
}
