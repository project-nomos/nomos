/**
 * Today overview -- the read model behind MobileApi.GetToday.
 *
 * Composes the day's brief from: today's Google Calendar events (live, best-effort
 * -- empty when Google isn't connected), pending commitments, and one-off reminders
 * due today (recurring tasks live on the Tasks page, so Today never duplicates them).
 * Gated on the daily briefing: when proactive autonomy is off,
 * `briefingEnabled` is false and the client shows a deep-link to enable it.
 */

import type { TenantContext } from "../auth/tenant-context.ts";
import { getConfigValue } from "../db/config.ts";
import { getActionItems, getWaitingOn } from "../proactive/commitment-tracker.ts";
import { getKysely } from "../db/client.ts";
import { CronStore } from "../cron/store.ts";
import { curateConsumerTasks } from "../cron/task-view.ts";
import { gapiFetch } from "../sdk/google-rest-mcp.ts";
import { createLogger } from "../lib/logger.ts";

const log = createLogger("today");
const CALENDAR_API = "https://www.googleapis.com/calendar/v3";

export interface TodayEvent {
  time: string;
  title: string;
  meta: string;
}
export interface TodayCommitment {
  id: string;
  description: string;
  due: string;
  priority: string;
  rankReason: string;
  direction: string;
  contact: string;
}
export interface TodayTask {
  id: string;
  name: string;
  schedule: string;
}
export interface TodayOverview {
  briefingEnabled: boolean;
  events: TodayEvent[];
  /** "Needs you" — items the user owes, ranked (p0..p3, most important first). */
  commitments: TodayCommitment[];
  tasks: TodayTask[];
  /** "Waiting on others" — items owed TO the user. */
  waiting: TodayCommitment[];
}

export async function getTodayOverview(ctx: TenantContext): Promise<TodayOverview> {
  const userId = ctx.userId;
  // The Today brief is the in-app face of the daily briefing; it's "on" whenever
  // proactive autonomy is on (default passive). Off -> the client shows the CTA.
  const mode = (await getConfigValue<string>("app.inboxAutonomy")) ?? "passive";
  const briefingEnabled = mode !== "off";

  const [events, mineRows, theirsRows, jobs] = await Promise.all([
    fetchTodayEvents(userId),
    // "Needs you" — items I owe, already ranked (p0..p3 first) by getActionItems.
    getActionItems(userId, { direction: "mine" }).catch(() => []),
    // "Waiting on others" — items owed to me.
    getWaitingOn(userId).catch(() => []),
    new CronStore().listJobs({ userId }),
  ]);

  // Resolve the other party's name for the waiting-on subtitle ("Waiting on <name>").
  // Batch-look up the linked contacts once, owner-scoped.
  const contactNames = await resolveContactNames(
    userId,
    [...mineRows, ...theirsRows].map((c) => c.contact_id),
  );

  const toToday = (c: (typeof mineRows)[number]): TodayCommitment => ({
    id: c.id,
    description: c.description,
    due: c.deadline ? relativeDay(c.deadline) : "",
    priority: c.priority ?? "",
    rankReason: c.rank_reason ?? "",
    direction: c.direction,
    contact: (c.contact_id && contactNames.get(c.contact_id)) || "",
  });
  const commitments: TodayCommitment[] = mineRows.slice(0, 8).map(toToday);
  const waiting: TodayCommitment[] = theirsRows.slice(0, 8).map(toToday);

  // Today shows ONLY one-off ("at") reminders that fall due by end of today --
  // recurring tasks ("every"/"cron") live on the Tasks page, so Today never
  // duplicates them (and recurring background automation lives on Loops).
  const tasks: TodayTask[] = curateConsumerTasks(jobs)
    .filter((t) => t.enabled && t.scheduleType === "at" && dueByToday(t.schedule))
    .slice(0, 6)
    .map((t) => ({ id: t.id, name: t.name, schedule: t.displaySchedule }));

  return { briefingEnabled, events, commitments, tasks, waiting };
}

/** Batch-resolve contact_id → display_name, owner-scoped. Missing/unnamed → absent. */
async function resolveContactNames(
  userId: string,
  ids: (string | null)[],
): Promise<Map<string, string>> {
  const uniq = [...new Set(ids.filter((x): x is string => x != null))];
  const map = new Map<string, string>();
  if (uniq.length === 0) return map;
  try {
    const rows = await getKysely()
      .selectFrom("contacts")
      .select(["id", "display_name"])
      .where("user_id", "=", userId)
      .where("id", "in", uniq)
      .execute();
    for (const r of rows) if (r.display_name) map.set(r.id, r.display_name);
  } catch {
    // Best-effort: a lookup failure just means no subtitle, never a broken brief.
  }
  return map;
}

/** A one-off ("at") reminder is on Today's plate when it's due by the end of today. */
function dueByToday(iso: string): boolean {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return false;
  const end = new Date();
  end.setHours(23, 59, 59, 999);
  return t <= end.getTime();
}

async function fetchTodayEvents(userId: string): Promise<TodayEvent[]> {
  try {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date();
    end.setHours(23, 59, 59, 999);
    const data = (await gapiFetch({
      userId,
      method: "GET",
      url: `${CALENDAR_API}/calendars/primary/events`,
      query: {
        timeMin: start.toISOString(),
        timeMax: end.toISOString(),
        singleEvents: true,
        orderBy: "startTime",
        maxResults: 12,
      },
    })) as {
      items?: Array<{
        summary?: string;
        location?: string;
        start?: { dateTime?: string; date?: string };
      }>;
    };
    return (data.items ?? []).map((e) => ({
      time: formatEventTime(e.start),
      title: e.summary ?? "(busy)",
      meta: e.location ?? "",
    }));
  } catch (err) {
    // No connected Google account / revoked token -> no calendar section.
    log.debug({ err: err instanceof Error ? err.message : err }, "today: no calendar events");
    return [];
  }
}

function formatEventTime(start?: { dateTime?: string; date?: string }): string {
  if (start?.date) return "All day";
  if (!start?.dateTime) return "";
  return new Date(start.dateTime).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}

function relativeDay(deadline: Date): string {
  const dayMs = 86_400_000;
  const d0 = new Date(deadline);
  d0.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((d0.getTime() - today.getTime()) / dayMs);
  if (diff < 0) return "Overdue";
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  return new Date(deadline).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
