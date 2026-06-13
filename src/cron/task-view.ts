/**
 * Consumer Tasks view model -- the pure shaping behind MobileApi.ListTasks.
 *
 * A "task" is any cron_jobs row the user owns: one-off reminders ("at") and
 * recurring jobs ("every"/"cron") that the user or the assistant scheduled on
 * their behalf. The instance's always-on background loops are owned by the
 * synthetic `system` tenant, so a per-user query (user_id = resolved owner) never
 * includes them -- Loops and Tasks stay cleanly separate.
 */

import type { CronJob } from "./types.ts";
import { prettifySchedule } from "./schedule-format.ts";

export interface ConsumerTask {
  id: string;
  name: string;
  prompt: string;
  /** Raw schedule string (the client edits this). */
  schedule: string;
  /** every | cron | at */
  scheduleType: string;
  /** Friendly, display-only cadence (e.g. "Every 15 minutes", "Once, Jun 13 at 5:00 PM"). */
  displaySchedule: string;
  enabled: boolean;
  source: string;
  lastRun: string;
}

export function toConsumerTask(j: CronJob): ConsumerTask {
  return {
    id: j.id,
    name: j.name,
    prompt: j.prompt,
    schedule: j.schedule,
    scheduleType: j.scheduleType,
    displaySchedule: prettifySchedule(j.schedule, j.scheduleType),
    enabled: j.enabled,
    source: j.source ?? "user",
    lastRun: j.lastRun ? j.lastRun.toISOString() : "",
  };
}

/** The user's scheduled tasks, enabled first then alphabetical. */
export function curateConsumerTasks(jobs: CronJob[]): ConsumerTask[] {
  return jobs
    .map(toConsumerTask)
    .sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name));
}
