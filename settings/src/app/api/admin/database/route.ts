import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export async function GET() {
  try {
    const sql = getDb();

    const [dbInfo] = await sql`
      SELECT
        current_database() AS db_name,
        version() AS pg_version,
        pg_size_pretty(pg_database_size(current_database())) AS db_size
    `;

    const tables = await sql`
      SELECT
        relname AS name,
        n_live_tup AS row_count,
        pg_size_pretty(pg_total_relation_size(quote_ident(relname))) AS size,
        pg_total_relation_size(quote_ident(relname)) AS size_bytes
      FROM pg_stat_user_tables
      ORDER BY relname
    `;

    let sessions: Record<string, unknown>[] = [];
    try {
      sessions = await sql`
        SELECT id, session_key, agent_id, model, status, token_usage, created_at, updated_at
        FROM sessions
        ORDER BY updated_at DESC
        LIMIT 20
      `;
    } catch {
      // sessions table may not exist
    }

    return NextResponse.json({
      connection: {
        dbName: dbInfo.db_name,
        pgVersion: dbInfo.pg_version,
        dbSize: dbInfo.db_size,
      },
      tables: tables.map((t) => ({
        name: t.name,
        rowCount: Number(t.row_count),
        size: t.size,
        sizeBytes: Number(t.size_bytes),
      })),
      sessions: sessions.map((s) => ({
        id: s.id,
        sessionKey: s.session_key,
        agentId: s.agent_id,
        model: s.model,
        status: s.status,
        tokenUsage: s.token_usage,
        createdAt: s.created_at,
        updatedAt: s.updated_at,
      })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: `Database connection failed: ${message}` }, { status: 500 });
  }
}
