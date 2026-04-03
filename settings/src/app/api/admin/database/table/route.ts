import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getDb } from "@/lib/db";

export async function GET(request: NextRequest) {
  const tableName = request.nextUrl.searchParams.get("name");
  const offset = parseInt(request.nextUrl.searchParams.get("offset") ?? "0", 10);
  const limit = parseInt(request.nextUrl.searchParams.get("limit") ?? "50", 10);

  if (!tableName) {
    return NextResponse.json({ error: "Missing table name" }, { status: 400 });
  }

  // Whitelist valid table names to prevent SQL injection
  const validTables = [
    "agent_permissions",
    "channel_allowlists",
    "config",
    "cron_jobs",
    "draft_messages",
    "integrations",
    "memory_chunks",
    "cron_runs",
    "pairing_requests",
    "sessions",
    "slack_user_tokens",
    "transcript_messages",
    "user_model",
  ];

  if (!validTables.includes(tableName)) {
    return NextResponse.json({ error: "Invalid table name" }, { status: 400 });
  }

  try {
    const sql = getDb();

    // Get columns
    const columns = await sql`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_name = ${tableName}
      ORDER BY ordinal_position
    `;

    // Get rows — use raw SQL with safe interpolation (table name is whitelisted above)
    const rows = await sql.unsafe(
      `SELECT * FROM "${tableName}" ORDER BY 1 DESC LIMIT ${limit} OFFSET ${offset}`,
    );

    // Get total count
    const [countResult] = await sql.unsafe(`SELECT count(*)::int AS total FROM "${tableName}"`);

    return NextResponse.json({
      table: tableName,
      columns: columns.map((c) => ({
        name: c.column_name,
        type: c.data_type,
      })),
      rows,
      total: countResult.total,
      offset,
      limit,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: `Query failed: ${message}` }, { status: 500 });
  }
}
