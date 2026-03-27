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

    // Get table names and sizes from pg_stat, then exact row counts via COUNT(*)
    const tableMeta = await sql`
      SELECT
        relname AS name,
        pg_size_pretty(pg_total_relation_size(quote_ident(relname))) AS size,
        pg_total_relation_size(quote_ident(relname)) AS size_bytes
      FROM pg_stat_user_tables
      ORDER BY relname
    `;

    // Get exact row counts for each table
    const tables = await Promise.all(
      tableMeta.map(async (t) => {
        const [row] = await sql.unsafe(`SELECT count(*)::int AS cnt FROM "${t.name as string}"`);
        return {
          name: t.name as string,
          size: t.size as string,
          sizeBytes: Number(t.size_bytes),
          rowCount: Number(row.cnt),
        };
      }),
    );

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
      tables,
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
