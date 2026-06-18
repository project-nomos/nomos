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

/**
 * Humanize a stored task name for display. The agent's `schedule_task` tool coins
 * slug-style names ("call-dentist", "water_plants", "checkUrgentEmails"); this turns
 * them into a Title-Cased label ("Call Dentist", "Water Plants") without touching the
 * stored value -- it stays display-only so name-keyed lookups (getJobByName,
 * isLoopUserDisabled) and the id-keyed edit round-trip are unaffected. A name that's
 * already a real sentence (contains a space) is left alone except for capitalization.
 */
export function prettifyTaskName(name: string): string {
  const raw = name.trim();
  if (!raw) return raw;
  // Already prose (has whitespace): only ensure the first letter is capitalized.
  if (/\s/.test(raw)) return raw.charAt(0).toUpperCase() + raw.slice(1);
  return raw
    .replace(/[-_]+/g, " ") // kebab/snake -> spaces
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2") // camelCase -> words
    .trim()
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

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

/**
 * Infra-owned cron sources that are NEVER user "tasks": the always-on background
 * loops (`system`) and the shipped templates (`bundled`). In hosted mode these
 * live under the synthetic `system` tenant so a per-user query already excludes
 * them -- but in power-user mode `systemTenant()` collapses onto the owner
 * (`local`), so they share the user's `user_id` and MUST be filtered by source.
 * Tasks = what the user or the assistant (`source: "agent"`/`"user"`) scheduled;
 * the curated infra loops live on the Loops surface (see cron/loop-view.ts).
 */
const INFRA_SOURCES = new Set(["system", "bundled"]);

export function toConsumerTask(j: CronJob): ConsumerTask {
  return {
    id: j.id,
    name: prettifyTaskName(j.name),
    prompt: j.prompt,
    schedule: j.schedule,
    scheduleType: j.scheduleType,
    displaySchedule: prettifySchedule(j.schedule, j.scheduleType),
    enabled: j.enabled,
    source: j.source ?? "user",
    lastRun: j.lastRun ? j.lastRun.toISOString() : "",
  };
}

/**
 * The user's scheduled tasks: every reminder/job the user or assistant created,
 * with the instance's infra loops (`system`/`bundled`) filtered out so they never
 * leak onto Tasks in power-user mode (where they share `user_id`). Enabled first,
 * then alphabetical.
 */
export function curateConsumerTasks(jobs: CronJob[]): ConsumerTask[] {
  return jobs
    .filter((j) => !INFRA_SOURCES.has(j.source ?? "user"))
    .map(toConsumerTask)
    .sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name));
}
