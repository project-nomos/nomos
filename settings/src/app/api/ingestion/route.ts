import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { notifyDaemonTriggerIngest, notifyDaemonTriggerDelta } from "@/lib/notify-daemon";

export async function GET() {
  try {
    const sql = getDb();

    const jobs = await sql`
      SELECT
        id, platform, source_type, status, contact,
        since_date, messages_processed, messages_skipped,
        last_cursor, error, started_at, finished_at,
        last_successful_at, delta_schedule, delta_enabled,
        run_type
      FROM ingest_jobs
      ORDER BY started_at DESC
    `;

    // Get summary stats
    const [stats] = await sql`
      SELECT
        COUNT(*)::int AS total_jobs,
        COUNT(*) FILTER (WHERE status = 'completed')::int AS completed,
        COUNT(*) FILTER (WHERE status = 'running')::int AS running,
        COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
        COALESCE(SUM(messages_processed), 0)::int AS total_messages,
        COALESCE(SUM(messages_skipped), 0)::int AS total_skipped
      FROM ingest_jobs
    `;

    return NextResponse.json({ jobs, stats });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { platform, action } = body;

    if (action === "toggle-delta") {
      const sql = getDb();
      await sql`
        UPDATE ingest_jobs
        SET delta_enabled = NOT delta_enabled
        WHERE platform = ${platform}
      `;
      return NextResponse.json({ ok: true });
    }

    if (action === "trigger-ingest") {
      notifyDaemonTriggerIngest(platform);
      return NextResponse.json({ ok: true, message: `Full ingestion triggered for ${platform}` });
    }

    if (action === "trigger-delta") {
      notifyDaemonTriggerDelta(platform);
      return NextResponse.json({ ok: true, message: `Delta sync triggered for ${platform}` });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    );
  }
}
