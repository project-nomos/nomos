import { NextResponse } from "next/server";
import postgres from "postgres";
import { writeEnv } from "@/lib/env";
import { validateOrigin } from "@/lib/validate-request";
import { getInlineSchema } from "@/lib/schema";

export async function POST(request: Request) {
  const forbidden = validateOrigin(request);
  if (forbidden) return forbidden;

  const body = (await request.json()) as { databaseUrl: string };
  const { databaseUrl } = body;

  if (!databaseUrl) {
    return NextResponse.json({ ok: false, error: "DATABASE_URL is required" }, { status: 400 });
  }

  // Test connection
  let sql: postgres.Sql | null = null;
  try {
    sql = postgres(databaseUrl, {
      max: 1,
      connect_timeout: 10,
      idle_timeout: 5,
      onnotice: () => {},
    });

    await sql`SELECT 1`;
  } catch (err) {
    try {
      await sql?.end();
    } catch {
      /* ignore */
    }
    const message = err instanceof Error ? err.message : "Connection failed";
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }

  // Check for pgvector extension (required)
  try {
    await sql`CREATE EXTENSION IF NOT EXISTS vector`;
  } catch (err) {
    try {
      await sql?.end();
    } catch {
      /* ignore */
    }
    const message = err instanceof Error ? err.message : "Failed to enable pgvector extension";
    return NextResponse.json(
      {
        ok: false,
        error: `pgvector extension not available: ${message}. Use pgvector/pgvector:pg17 Docker image or install the extension.`,
      },
      { status: 400 },
    );
  }

  // Run migrations (inline schema)
  try {
    const schema = getInlineSchema();
    await sql.unsafe(schema);
  } catch (err) {
    try {
      await sql?.end();
    } catch {
      /* ignore */
    }
    const message = err instanceof Error ? err.message : "Migration failed";
    return NextResponse.json({ ok: false, error: `Migration failed: ${message}` }, { status: 500 });
  }

  // Persist DATABASE_URL to .env
  try {
    writeEnv({ DATABASE_URL: databaseUrl });
  } catch {
    // Non-fatal — DB is connected, .env write is secondary
  }

  // Close the test connection (the app DB client will reconnect with new URL)
  try {
    await sql.end();
  } catch {
    /* ignore */
  }

  // Set process.env so the shared getDb() picks it up for subsequent requests
  process.env.DATABASE_URL = databaseUrl;

  return NextResponse.json({
    ok: true,
    message: "Database connected and migrations applied",
  });
}
