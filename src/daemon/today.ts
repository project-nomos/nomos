/**
 * Today overview -- the read model behind MobileApi.GetToday.
 *
 * Composes the day's brief from: today's Google Calendar events (live, best-effort
 * -- empty when Google isn't connected), pending commitments, and the user's
 * scheduled tasks. Gated on the daily briefing: when proactive autonomy is off,
 * `briefingEnabled` is false and the client shows a deep-link to enable it.
 */

import type { TenantContext } from "../auth/tenant-context.ts";
import { getConfigValue } from "../db/config.ts";
import { getPendingCommitments } from "../proactive/commitment-tracker.ts";
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
}
export interface TodayTask {
  id: string;
  name: string;
  schedule: string;
}
export interface TodayOverview {
  briefingEnabled: boolean;
  events: TodayEvent[];
  commitments: TodayCommitment[];
  tasks: TodayTask[];
}

export async function getTodayOverview(ctx: TenantContext): Promise<TodayOverview> {
  const userId = ctx.userId;
  // The Today brief is the in-app face of the daily briefing; it's "on" whenever
  // proactive autonomy is on (default passive). Off -> the client shows the CTA.
  const mode = (await getConfigValue<string>("app.inboxAutonomy")) ?? "passive";
  const briefingEnabled = mode !== "off";

  const [events, commitmentRows, jobs] = await Promise.all([
    fetchTodayEvents(userId),
    getPendingCommitments(userId).catch(() => []),
    new CronStore().listJobs({ userId }),
  ]);

  const commitments: TodayCommitment[] = commitmentRows.slice(0, 8).map((c) => ({
    id: c.id,
    description: c.description,
    due: c.deadline ? relativeDay(c.deadline) : "",
  }));

  const tasks: TodayTask[] = curateConsumerTasks(jobs)
    .filter((t) => t.enabled)
    .slice(0, 6)
    .map((t) => ({ id: t.id, name: t.name, schedule: t.displaySchedule }));

  return { briefingEnabled, events, commitments, tasks };
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
