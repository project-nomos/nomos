/**
 * Draft message CRUD operations.
 *
 * Stores agent-generated responses that await user approval before
 * being sent as the authenticated Slack user.
 */

import { getDb } from "./client.ts";

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
  const sql = getDb();
  const ttl = params.ttlHours ?? DEFAULT_TTL_HOURS;

  const [row] = await sql<DraftRow[]>`
    INSERT INTO draft_messages (platform, channel_id, thread_id, user_id, in_reply_to, content, context, expires_at)
    VALUES (
      ${params.platform},
      ${params.channelId},
      ${params.threadId ?? null},
      ${params.userId},
      ${params.inReplyTo},
      ${params.content},
      ${JSON.stringify(params.context ?? {})},
      now() + ${`${ttl} hours`}::interval
    )
    RETURNING *
  `;
  return row;
}

export async function getDraft(id: string): Promise<DraftRow | null> {
  const sql = getDb();
  const [row] = await sql<DraftRow[]>`
    SELECT * FROM draft_messages WHERE id = ${id}
  `;
  return row ?? null;
}

export async function getDraftByPrefix(prefix: string): Promise<DraftRow | null> {
  const sql = getDb();
  const [row] = await sql<DraftRow[]>`
    SELECT * FROM draft_messages
    WHERE id::text LIKE ${prefix + "%"}
    ORDER BY created_at DESC
    LIMIT 1
  `;
  return row ?? null;
}

export async function listPendingDrafts(userId?: string): Promise<DraftRow[]> {
  const sql = getDb();
  if (userId) {
    return sql<DraftRow[]>`
      SELECT * FROM draft_messages
      WHERE status = 'pending' AND expires_at > now() AND user_id = ${userId}
      ORDER BY created_at DESC
    `;
  }
  return sql<DraftRow[]>`
    SELECT * FROM draft_messages
    WHERE status = 'pending' AND expires_at > now()
    ORDER BY created_at DESC
  `;
}

export async function approveDraft(id: string): Promise<DraftRow | null> {
  const sql = getDb();
  const [row] = await sql<DraftRow[]>`
    UPDATE draft_messages
    SET status = 'approved', approved_at = now()
    WHERE id = ${id} AND status = 'pending'
    RETURNING *
  `;
  return row ?? null;
}

export async function rejectDraft(id: string): Promise<DraftRow | null> {
  const sql = getDb();
  const [row] = await sql<DraftRow[]>`
    UPDATE draft_messages
    SET status = 'rejected'
    WHERE id = ${id} AND status = 'pending'
    RETURNING *
  `;
  return row ?? null;
}

export async function markDraftSent(id: string): Promise<DraftRow | null> {
  const sql = getDb();
  const [row] = await sql<DraftRow[]>`
    UPDATE draft_messages
    SET status = 'sent', sent_at = now()
    WHERE id = ${id} AND status = 'approved'
    RETURNING *
  `;
  return row ?? null;
}

export async function cleanExpiredDrafts(): Promise<number> {
  const sql = getDb();
  const result = await sql`
    DELETE FROM draft_messages WHERE expires_at < now()
  `;
  return result.count;
}
