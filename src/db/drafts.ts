/**
 * Draft message CRUD operations.
 *
 * Stores agent-generated responses that await user approval before
 * being sent as the authenticated Slack user.
 */

import { sql } from "kysely";
import { getKysely } from "./client.ts";

export interface DraftRow {
  id: string;
  platform: string;
  channel_id: string;
  thread_id: string | null;
  user_id: string;
  in_reply_to: string;
  content: string;
  context: Record<string, unknown>;
  status: "pending" | "approved" | "rejected" | "sent";
  created_at: Date;
  approved_at: Date | null;
  sent_at: Date | null;
  expires_at: Date;
}

const DEFAULT_TTL_HOURS = 24;

export async function createDraft(params: {
  platform: string;
  channelId: string;
  threadId?: string;
  userId: string;
  inReplyTo: string;
  content: string;
  context?: Record<string, unknown>;
  ttlHours?: number;
}): Promise<DraftRow> {
  const db = getKysely();
  const ttl = params.ttlHours ?? DEFAULT_TTL_HOURS;

  const row = await db
    .insertInto("draft_messages")
    .values({
      platform: params.platform,
      channel_id: params.channelId,
      thread_id: params.threadId ?? null,
      user_id: params.userId,
      in_reply_to: params.inReplyTo,
      content: params.content,
      context: JSON.stringify(params.context ?? {}),
      expires_at: sql`now() + ${`${ttl} hours`}::interval`,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  return row as unknown as DraftRow;
}

export async function getDraft(id: string): Promise<DraftRow | null> {
  const db = getKysely();
  const row = await db
    .selectFrom("draft_messages")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();
  return (row as unknown as DraftRow) ?? null;
}

export async function getDraftByPrefix(prefix: string): Promise<DraftRow | null> {
  const db = getKysely();
  const row = await db
    .selectFrom("draft_messages")
    .selectAll()
    .where(sql`id::text`, "like", `${prefix}%`)
    .orderBy("created_at", "desc")
    .limit(1)
    .executeTakeFirst();
  return (row as unknown as DraftRow) ?? null;
}

export async function listPendingDrafts(userId?: string): Promise<DraftRow[]> {
  const db = getKysely();
  let query = db
    .selectFrom("draft_messages")
    .selectAll()
    .where("status", "=", "pending")
    .where("expires_at", ">", sql<Date>`now()`)
    .orderBy("created_at", "desc");

  if (userId) {
    query = query.where("user_id", "=", userId);
  }

  return query.execute() as unknown as Promise<DraftRow[]>;
}

export async function approveDraft(id: string): Promise<DraftRow | null> {
  const db = getKysely();
  const row = await db
    .updateTable("draft_messages")
    .set({ status: "approved", approved_at: sql<Date>`now()` })
    .where("id", "=", id)
    .where("status", "=", "pending")
    .returningAll()
    .executeTakeFirst();
  return (row as unknown as DraftRow) ?? null;
}

export async function rejectDraft(id: string): Promise<DraftRow | null> {
  const db = getKysely();
  const row = await db
    .updateTable("draft_messages")
    .set({ status: "rejected" })
    .where("id", "=", id)
    .where("status", "=", "pending")
    .returningAll()
    .executeTakeFirst();
  return (row as unknown as DraftRow) ?? null;
}

export async function markDraftSent(id: string): Promise<DraftRow | null> {
  const db = getKysely();
  const row = await db
    .updateTable("draft_messages")
    .set({ status: "sent", sent_at: sql<Date>`now()` })
    .where("id", "=", id)
    .where("status", "=", "approved")
    .returningAll()
    .executeTakeFirst();
  return (row as unknown as DraftRow) ?? null;
}

export async function cleanExpiredDrafts(): Promise<number> {
  const db = getKysely();
  const result = await db
    .deleteFrom("draft_messages")
    .where("expires_at", "<", sql<Date>`now()`)
    .executeTakeFirst();
  return Number(result.numDeletedRows ?? 0n);
}
