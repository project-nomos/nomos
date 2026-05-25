import { NextResponse } from "next/server";
import { notifyDaemonReloadProactive } from "@/lib/notify-daemon";
import { validateOrigin } from "@/lib/validate-request";

/**
 * Trigger the daemon to re-register inbox/calendar/morning-briefing cron jobs
 * after the user updates inbox autonomy settings. Fire-and-forget — the
 * daemon's NOTIFY listener picks this up asynchronously.
 */
export async function POST(request: Request) {
  const forbidden = validateOrigin(request);
  if (forbidden) return forbidden;

  notifyDaemonReloadProactive();
  return NextResponse.json({ ok: true });
}
