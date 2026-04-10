import { sql } from "kysely";
import { getKysely } from "./client.ts";

export interface SessionRow {
  id: string;
  session_key: string;
  agent_id: string;
  model: string | null;
  status: string;
  metadata: Record<string, unknown>;
  token_usage: { input: number; output: number };
  total_cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  turn_count: number;
  created_at: Date;
  updated_at: Date;
}

export async function createSession(params: {
  sessionKey: string;
  agentId?: string;
  model?: string;
  metadata?: Record<string, unknown>;
}): Promise<SessionRow> {
  const db = getKysely();
  const row = await db
    .insertInto("sessions")
    .values({
      session_key: params.sessionKey,
      agent_id: params.agentId ?? "default",
      model: params.model ?? null,
      metadata: JSON.stringify(params.metadata ?? {}),
    })
    .onConflict((oc) =>
      oc.column("session_key").doUpdateSet({
        updated_at: sql`now()`,
        status: "active",
      }),
    )
    .returningAll()
    .executeTakeFirstOrThrow();
  return row as unknown as SessionRow;
}

export async function getSession(sessionId: string): Promise<SessionRow | null> {
  const db = getKysely();
  const row = await db
    .selectFrom("sessions")
    .selectAll()
    .where("id", "=", sessionId)
    .executeTakeFirst();
  return (row as unknown as SessionRow) ?? null;
}

export async function getSessionByKey(sessionKey: string): Promise<SessionRow | null> {
  const db = getKysely();
  const row = await db
    .selectFrom("sessions")
    .selectAll()
    .where("session_key", "=", sessionKey)
    .executeTakeFirst();
  return (row as unknown as SessionRow) ?? null;
}

export async function listSessions(params?: {
  status?: string;
  limit?: number;
}): Promise<SessionRow[]> {
  const db = getKysely();
  const status = params?.status ?? "active";
  const limit = params?.limit ?? 50;

  const rows = await db
    .selectFrom("sessions")
    .selectAll()
    .where("status", "=", status)
    .orderBy("updated_at", "desc")
    .limit(limit)
    .execute();
  return rows as unknown as SessionRow[];
}

export async function updateSessionUsage(
  sessionId: string,
  inputTokens: number,
  outputTokens: number,
): Promise<void> {
  const db = getKysely();
  await db
    .updateTable("sessions")
    .set({
      token_usage: sql`jsonb_build_object(
        'input', (COALESCE((token_usage->>'input')::int, 0) + ${inputTokens}),
        'output', (COALESCE((token_usage->>'output')::int, 0) + ${outputTokens})
      )`,
      updated_at: sql`now()`,
    })
    .where("id", "=", sessionId)
    .execute();
}

export async function updateSessionModel(sessionId: string, model: string): Promise<void> {
  const db = getKysely();
  await db
    .updateTable("sessions")
    .set({ model, updated_at: sql`now()` })
    .where("id", "=", sessionId)
    .execute();
}

export async function updateSessionSdkId(sessionKey: string, sdkSessionId: string): Promise<void> {
  const db = getKysely();
  await db
    .updateTable("sessions")
    .set({
      metadata: sql`jsonb_set(COALESCE(metadata, '{}'), '{sdkSessionId}', ${JSON.stringify(sdkSessionId)}::jsonb)`,
      updated_at: sql`now()`,
    })
    .where("session_key", "=", sessionKey)
    .execute();
}

export async function archiveSession(sessionId: string): Promise<void> {
  const db = getKysely();
  await db
    .updateTable("sessions")
    .set({ status: "archived", updated_at: sql`now()` })
    .where("id", "=", sessionId)
    .execute();
}

export async function deleteSession(sessionId: string): Promise<void> {
  const db = getKysely();
  await db.deleteFrom("sessions").where("id", "=", sessionId).execute();
}

export async function updateSessionCost(
  sessionKey: string,
  costUsd: number,
  inputTokens: number,
  outputTokens: number,
): Promise<void> {
  const db = getKysely();
  await db
    .updateTable("sessions")
    .set({
      total_cost_usd: sql`total_cost_usd + ${costUsd}`,
      input_tokens: sql`input_tokens + ${inputTokens}`,
      output_tokens: sql`output_tokens + ${outputTokens}`,
      turn_count: sql`turn_count + 1`,
      updated_at: sql`now()`,
    })
    .where("session_key", "=", sessionKey)
    .execute();
}
