import { sql } from "kysely";
import { getKysely } from "./client.ts";

export interface TranscriptMessageRow {
  id: number;
  session_id: string;
  role: string;
  content: string | unknown[];
  usage: { input: number; output: number } | null;
  created_at: Date;
}

export async function appendTranscriptMessage(params: {
  sessionId: string;
  role: string;
  content: string | unknown[];
  usage?: { input: number; output: number };
  /** Denormalized owner; defaults to 'local' when omitted. */
  userId?: string;
}): Promise<void> {
  const db = getKysely();
  await db
    .insertInto("transcript_messages")
    .values({
      session_id: params.sessionId,
      user_id: params.userId ?? "local",
      role: params.role,
      // Pass the value (string/array/object), not a pre-stringified JSON string:
      // the postgres-js driver serializes to jsonb exactly once. A JSON.stringify
      // here double-encodes into a jsonb *string*, so usage reads back as a string
      // and usage.input is undefined (and content comes back quote-wrapped).
      content: params.content as unknown as string,
      usage: (params.usage ?? null) as unknown as string | null,
    })
    .execute();
}

export async function getTranscript(
  sessionId: string,
  limit?: number,
): Promise<Array<{ role: string; content: string | unknown[] }>> {
  const db = getKysely();
  let query = db
    .selectFrom("transcript_messages")
    .select(["role", "content"])
    .where("session_id", "=", sessionId)
    .orderBy("id", "asc");

  if (limit) {
    query = query.limit(limit);
  }

  const rows = await query.execute();
  return rows.map((row) => ({
    role: row.role,
    content: row.content as string | unknown[],
  }));
}

export async function getTranscriptWithUsage(sessionId: string): Promise<TranscriptMessageRow[]> {
  const db = getKysely();
  const rows = await db
    .selectFrom("transcript_messages")
    .selectAll()
    .where("session_id", "=", sessionId)
    .orderBy("id", "asc")
    .execute();

  return rows as unknown as TranscriptMessageRow[];
}

export async function countTranscriptMessages(sessionId: string): Promise<number> {
  const db = getKysely();
  const row = await db
    .selectFrom("transcript_messages")
    .select(sql<number>`count(*)::int`.as("count"))
    .where("session_id", "=", sessionId)
    .executeTakeFirstOrThrow();
  return row.count;
}

export async function deleteLastTranscriptMessages(
  sessionId: string,
  count: number,
): Promise<number> {
  const db = getKysely();
  const result = await db
    .deleteFrom("transcript_messages")
    .where(
      "id",
      "in",
      db
        .selectFrom("transcript_messages")
        .select("id")
        .where("session_id", "=", sessionId)
        .orderBy("id", "desc")
        .limit(count),
    )
    .executeTakeFirst();
  return Number(result.numDeletedRows ?? 0n);
}
