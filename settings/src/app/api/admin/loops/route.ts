import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { notifyDaemonReloadCron } from "@/lib/notify-daemon";

// The settings app is the power-user (single-owner) dashboard with no auth layer,
// so it operates only on the local owner -- matching the sibling admin routes
// (memory/vault). System infra crons (wiki-compile, auto-dream, ...) are read-only
// here so the UI can never break the daemon's own jobs.
const OWNER = "local";

/**
 * Autonomous loops admin API. Lists every cron_jobs row (bundled / user / agent)
 * so the user can audit and control them -- including loops the agent created for
 * itself -- and mutate them: enable/disable, change schedule, or delete.
 *
 * In power-user mode this is the single local owner; the page is the human
 * oversight surface for the agent's full loop autonomy.
 */
export async function GET() {
  try {
    const sql = getDb();
    const loops = await sql`
      SELECT id, name, schedule, schedule_type, session_target, delivery_mode,
             enabled, source, error_count, last_run, last_error, created_at, prompt
      FROM cron_jobs
      WHERE user_id = ${OWNER}
      ORDER BY source, name
    `;
    return NextResponse.json({
      loops: loops.map((l) => ({
        id: l.id as string,
        name: l.name as string,
        schedule: l.schedule as string,
        scheduleType: l.schedule_type as string,
        sessionTarget: l.session_target as string,
        deliveryMode: l.delivery_mode as string,
        enabled: l.enabled as boolean,
        source: (l.source as string) ?? "bundled",
        errorCount: Number(l.error_count ?? 0),
        lastRun: l.last_run ? new Date(l.last_run as string).toISOString() : null,
        lastError: (l.last_error as string) ?? null,
        createdAt: l.created_at ? new Date(l.created_at as string).toISOString() : null,
        prompt: l.prompt as string,
      })),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "failed to list loops" },
      { status: 500 },
    );
  }
}

/**
 * Mutate a loop. Body: { id, action: "enable"|"disable"|"delete"|"update", schedule? }.
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      id?: string;
      action?: "enable" | "disable" | "delete" | "update";
      schedule?: string;
    };
    if (!body.id || !body.action) {
      return NextResponse.json({ error: "id and action are required" }, { status: 400 });
    }
    const sql = getDb();

    // Resolve the target and refuse to touch system infra jobs. Scoped to the
    // local owner so the route never reaches another tenant's rows.
    const [target] = await sql`
      SELECT source FROM cron_jobs WHERE id = ${body.id} AND user_id = ${OWNER}
    `;
    if (!target) {
      return NextResponse.json({ error: "loop not found" }, { status: 404 });
    }
    if (target.source === "system") {
      return NextResponse.json(
        { error: "system jobs are managed by the daemon and cannot be changed here" },
        { status: 403 },
      );
    }

    switch (body.action) {
      case "enable":
        await sql`UPDATE cron_jobs SET enabled = true WHERE id = ${body.id} AND user_id = ${OWNER}`;
        break;
      case "disable":
        await sql`UPDATE cron_jobs SET enabled = false WHERE id = ${body.id} AND user_id = ${OWNER}`;
        break;
      case "delete":
        await sql`DELETE FROM cron_jobs WHERE id = ${body.id} AND user_id = ${OWNER}`;
        break;
      case "update":
        if (!body.schedule) {
          return NextResponse.json({ error: "schedule required for update" }, { status: 400 });
        }
        await sql`UPDATE cron_jobs SET schedule = ${body.schedule} WHERE id = ${body.id} AND user_id = ${OWNER}`;
        break;
      default:
        return NextResponse.json({ error: "unknown action" }, { status: 400 });
    }

    // Tell the running daemon to reload its cron schedule so the change is live
    // without a restart (the daemon listens on the nomos_reload NOTIFY channel).
    notifyDaemonReloadCron();
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "failed to update loop" },
      { status: 500 },
    );
  }
}
