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
}): Promise<void> {
  const db = getKysely();
  await db
    .insertInto("transcript_messages")
    .values({
      session_id: params.sessionId,
      role: params.role,
      content: JSON.stringify(params.content),
      usage: params.usage ? JSON.stringify(params.usage) : null,
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
