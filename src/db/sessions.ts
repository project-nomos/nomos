import { getDb } from "./client.ts";

export interface SessionRow {
  id: string;
  session_key: string;
  agent_id: string;
  model: string | null;
  status: string;
  metadata: Record<string, unknown>;
  token_usage: { input: number; output: number };
  created_at: Date;
  updated_at: Date;
}

export async function createSession(params: {
  sessionKey: string;
  agentId?: string;
  model?: string;
  metadata?: Record<string, unknown>;
}): Promise<SessionRow> {
  const sql = getDb();
  const [row] = await sql<SessionRow[]>`
    INSERT INTO sessions (session_key, agent_id, model, metadata)
    VALUES (
      ${params.sessionKey},
      ${params.agentId ?? "default"},
      ${params.model ?? null},
      ${JSON.stringify(params.metadata ?? {})}
    )
    ON CONFLICT (session_key) DO UPDATE SET
      updated_at = now(),
      status = 'active'
    RETURNING *
  `;
  return row;
}

export async function getSession(sessionId: string): Promise<SessionRow | null> {
  const sql = getDb();
  const [row] = await sql<SessionRow[]>`
    SELECT * FROM sessions WHERE id = ${sessionId}
  `;
  return row ?? null;
}

export async function getSessionByKey(sessionKey: string): Promise<SessionRow | null> {
  const sql = getDb();
  const [row] = await sql<SessionRow[]>`
    SELECT * FROM sessions WHERE session_key = ${sessionKey}
  `;
  return row ?? null;
}

export async function listSessions(params?: {
  status?: string;
  limit?: number;
}): Promise<SessionRow[]> {
  const sql = getDb();
  const status = params?.status ?? "active";
  const limit = params?.limit ?? 50;

  return sql<SessionRow[]>`
    SELECT * FROM sessions
    WHERE status = ${status}
    ORDER BY updated_at DESC
    LIMIT ${limit}
  `;
}

export async function updateSessionUsage(
  sessionId: string,
  inputTokens: number,
  outputTokens: number,
): Promise<void> {
  const sql = getDb();
  await sql`
    UPDATE sessions SET
      token_usage = jsonb_build_object(
        'input', (COALESCE((token_usage->>'input')::int, 0) + ${inputTokens}),
        'output', (COALESCE((token_usage->>'output')::int, 0) + ${outputTokens})
      ),
      updated_at = now()
    WHERE id = ${sessionId}
  `;
}

export async function updateSessionModel(sessionId: string, model: string): Promise<void> {
  const sql = getDb();
  await sql`
    UPDATE sessions SET model = ${model}, updated_at = now()
    WHERE id = ${sessionId}
  `;
}

export async function updateSessionSdkId(sessionKey: string, sdkSessionId: string): Promise<void> {
  const sql = getDb();
  await sql`
    UPDATE sessions SET
      metadata = jsonb_set(COALESCE(metadata, '{}'), '{sdkSessionId}', ${JSON.stringify(sdkSessionId)}::jsonb),
      updated_at = now()
    WHERE session_key = ${sessionKey}
  `;
}

export async function archiveSession(sessionId: string): Promise<void> {
  const sql = getDb();
  await sql`
    UPDATE sessions SET status = 'archived', updated_at = now()
    WHERE id = ${sessionId}
  `;
}

export async function deleteSession(sessionId: string): Promise<void> {
  const sql = getDb();
  await sql`DELETE FROM sessions WHERE id = ${sessionId}`;
}
