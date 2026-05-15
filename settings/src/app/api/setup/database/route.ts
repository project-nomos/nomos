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

  // Test connection. If the target database doesn't exist yet (Postgres
  // error 3D000) we try to create it by connecting to the cluster-default
  // "postgres" database and issuing `CREATE DATABASE`. On a fresh nomos
  // install this is the common case — the user has Postgres running but
  // no `nomos` database yet.
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
    const pgErr = err as { code?: string };
    if (pgErr?.code === "3D000") {
      try {
        await sql?.end();
      } catch {
        /* ignore */
      }
      try {
        const parsed = new URL(databaseUrl);
        const targetDb = parsed.pathname.replace(/^\//, "");
        if (!targetDb || !/^[a-zA-Z_][\w]*$/.test(targetDb)) {
          throw new Error(`Refusing to auto-create database with unsafe name: ${targetDb}`);
        }
        parsed.pathname = "/postgres";
        const admin = postgres(parsed.toString(), {
          max: 1,
          connect_timeout: 10,
          idle_timeout: 5,
          onnotice: () => {},
        });
        try {
          await admin.unsafe(`CREATE DATABASE "${targetDb}"`);
        } finally {
          await admin.end().catch(() => {});
        }
        // Reconnect to the now-existing database
        sql = postgres(databaseUrl, {
          max: 1,
          connect_timeout: 10,
          idle_timeout: 5,
          onnotice: () => {},
        });
        await sql`SELECT 1`;
      } catch (createErr) {
        try {
          await sql?.end();
        } catch {
          /* ignore */
        }
        const message =
          createErr instanceof Error ? createErr.message : "Failed to auto-create database";
        return NextResponse.json(
          { ok: false, error: `Database does not exist and auto-create failed: ${message}` },
          { status: 400 },
        );
      }
    } else {
      try {
        await sql?.end();
      } catch {
        /* ignore */
      }
      const message = err instanceof Error ? err.message : "Connection failed";
      return NextResponse.json({ ok: false, error: message }, { status: 400 });
    }
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

  // Signal the parent daemon (if we're a child of it) to re-initialize.
  // On fresh installs the daemon boots in "setup-only" mode when the DB
  // is missing. After the wizard creates the DB, we ask the parent to
  // exit so launchd's KeepAlive respawns it and the full runtime comes up.
  // NOMOS_PARENT_DAEMON is set by the daemon when it spawns Settings UI,
  // so we only signal when we're actually a daemon child (not pnpm/zsh
  // in dev mode).
  if (process.env.NOMOS_PARENT_DAEMON === "1" && process.ppid && process.ppid !== 1) {
    try {
      process.kill(process.ppid, "SIGTERM");
    } catch {
      // Parent may not exist or we lack perms — non-fatal.
    }
  }

  return NextResponse.json({
    ok: true,
    message: "Database connected and migrations applied",
  });
}
