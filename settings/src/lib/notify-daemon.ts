/**
 * Notify the running daemon of state changes via Postgres LISTEN/NOTIFY.
 *
 * The daemon already holds a postgres connection; we just issue a NOTIFY
 * on the shared `nomos_reload` channel and the daemon's LISTEN handler
 * dispatches to the right reload/ingest path. No new ports, no subprocess
 * gRPC bridge, no cross-package node_modules headaches.
 *
 * Fire-and-forget: failures are logged but don't block the response.
 */

import { getDb } from "@/lib/db";

const CHANNEL = "nomos_reload";

async function notify(payload: string): Promise<void> {
  try {
    const sql = getDb();
    await sql.notify(CHANNEL, payload);
  } catch (err) {
    // Daemon may not be listening yet, or DB is down. Non-fatal.
    console.warn(`[notify-daemon] NOTIFY ${CHANNEL} '${payload}' failed:`, err);
  }
}

export function notifyDaemonReload(): void {
  void notify("slack-workspaces");
}

/** Trigger a full ingestion for the given platform. */
export function notifyDaemonTriggerIngest(platform: string): void {
  void notify(`trigger-ingest:${platform}`);
}

/** Trigger a delta sync for the given platform. */
export function notifyDaemonTriggerDelta(platform: string): void {
  void notify(`trigger-delta:${platform}`);
}

/** Re-register proactive (inbox/calendar/briefing) cron jobs after a config change. */
export function notifyDaemonReloadProactive(): void {
  void notify("reload-proactive");
}

/** Reload the cron schedule from the DB after a loop enable/disable/delete/edit. */
export function notifyDaemonReloadCron(): void {
  void notify("reload-cron");
}
