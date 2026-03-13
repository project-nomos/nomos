import { getDb } from "./client.ts";

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
  const sql = getDb();
  await sql`
    INSERT INTO transcript_messages (session_id, role, content, usage)
    VALUES (
      ${params.sessionId},
      ${params.role},
      ${JSON.stringify(params.content)},
      ${params.usage ? JSON.stringify(params.usage) : null}
    )
  `;
}

export async function getTranscript(
  sessionId: string,
  limit?: number,
): Promise<Array<{ role: string; content: string | unknown[] }>> {
  const sql = getDb();
  const rows = await sql<TranscriptMessageRow[]>`
    SELECT role, content FROM transcript_messages
    WHERE session_id = ${sessionId}
    ORDER BY id ASC
    ${limit ? sql`LIMIT ${limit}` : sql``}
  `;

  return rows.map((row) => ({
    role: row.role,
    content: row.content,
  }));
}

export async function getTranscriptWithUsage(sessionId: string): Promise<TranscriptMessageRow[]> {
  const sql = getDb();
  return sql<TranscriptMessageRow[]>`
    SELECT * FROM transcript_messages
    WHERE session_id = ${sessionId}
    ORDER BY id ASC
  `;
}

export async function countTranscriptMessages(sessionId: string): Promise<number> {
  const sql = getDb();
  const [row] = await sql<[{ count: number }]>`
    SELECT count(*)::int as count FROM transcript_messages
    WHERE session_id = ${sessionId}
  `;
  return row.count;
}

export async function deleteLastTranscriptMessages(
  sessionId: string,
  count: number,
): Promise<number> {
  const sql = getDb();
  const result = await sql`
    DELETE FROM transcript_messages
    WHERE id IN (
      SELECT id FROM transcript_messages
      WHERE session_id = ${sessionId}
      ORDER BY id DESC
      LIMIT ${count}
    )
  `;
  return result.count;
}
