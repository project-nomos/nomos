/**
 * Proactive feature scheduler.
 *
 * Registers cron jobs for inbox/calendar/morning-briefing autonomy and the
 * existing commitment + triage helpers. Idempotent — upserts on each call,
 * matching the pattern in `delta-sync.ts`. Triggered from gateway startup.
 *
 * Inbox/calendar/morning-briefing jobs route results to the default
 * notification channel via the cron engine's `announce` mode. The agent
 * uses a `[NOACTION]` sentinel to suppress noise on quiet runs.
 */

import { CronStore } from "../cron/store.ts";
import { systemTenant } from "../auth/tenant-context.ts";
import type { CronJobUpdate } from "../cron/types.ts";
import {
  getCommitmentsForReminder,
  markReminded,
  expireOverdueCommitments,
} from "./commitment-tracker.ts";
import { generateTriage } from "./priority-triage.ts";
import { inboxScanJobSpec, type ProactiveJobSpec } from "./inbox-watcher.ts";
import { calendarScanJobSpec } from "./calendar-watcher.ts";
import { morningBriefingJobSpec, DEFAULT_BRIEFING_CRON } from "./morning-briefing.ts";
import { loadEnvConfigAsync } from "../config/env.ts";
import { getNotificationDefault } from "../db/notification-defaults.ts";
import { createLogger } from "../lib/logger.ts";

const log = createLogger("proactive-scheduler");

const INBOX_JOB_NAME = "proactive:inbox-watcher";
const CALENDAR_JOB_NAME = "proactive:calendar-watcher";
const BRIEFING_JOB_NAME = "proactive:morning-briefing";

/**
 * Register (or update, or remove) the proactive cron jobs based on current
 * config. Called during daemon startup and after the user toggles autonomy.
 */
export async function registerProactiveJobs(): Promise<void> {
  const config = await loadEnvConfigAsync();
  const store = new CronStore();
  const target = await getNotificationDefault();

  const autonomy = config.inboxAutonomy;
  const inboxInterval = config.inboxScanInterval ?? "15m";
  const calendarInterval = config.calendarScanInterval ?? "5m";
  const briefingCron = config.briefingCron ?? DEFAULT_BRIEFING_CRON;

  let changed = false;

  if (autonomy === "off") {
    // Disable all proactive jobs (don't delete — preserve run history).
    for (const name of [INBOX_JOB_NAME, CALENDAR_JOB_NAME, BRIEFING_JOB_NAME]) {
      const existing = await store.getJobByName(name);
      if (existing?.enabled) {
        await store.updateJob(existing.id, { enabled: false });
        changed = true;
        log.info({ name }, "Disabled job (inbox autonomy is off)");
      }
    }
    if (changed) process.emit("cron:refresh" as never);
    return;
  }

  if (!target) {
    log.warn(
      "No default notification channel configured — proactive jobs not registered. Set one via the Settings UI.",
    );
    return;
  }

  // Upsert each job. The cron engine routes the prompt through AgentRuntime
  // (which has google-workspace MCP + DraftManager); `announce` mode posts
  // the agent's reply to the default channel.
  changed = (await upsertJob(store, inboxScanJobSpec(autonomy, inboxInterval), target)) || changed;
  changed = (await upsertJob(store, calendarScanJobSpec(calendarInterval), target)) || changed;
  changed = (await upsertJob(store, morningBriefingJobSpec(briefingCron), target)) || changed;

  if (changed) process.emit("cron:refresh" as never);
}

async function upsertJob(
  store: CronStore,
  spec: ProactiveJobSpec,
  target: { platform: string; channelId: string },
): Promise<boolean> {
  const existing = await store.getJobByName(spec.name);

  if (!existing) {
    await store.createJob({
      userId: systemTenant().userId,
      name: spec.name,
      schedule: spec.schedule,
      scheduleType: spec.scheduleType,
      sessionTarget: "isolated",
      deliveryMode: "announce",
      prompt: spec.prompt,
      platform: target.platform,
      channelId: target.channelId,
      enabled: true,
      errorCount: 0,
    });
    log.info({ name: spec.name, schedule: spec.schedule }, "Registered job");
    return true;
  }

  // Compute minimal diff to avoid no-op writes.
  const updates: CronJobUpdate = {};
  if (existing.schedule !== spec.schedule) updates.schedule = spec.schedule;
  if (existing.scheduleType !== spec.scheduleType) updates.scheduleType = spec.scheduleType;
  if (existing.prompt !== spec.prompt) updates.prompt = spec.prompt;
  if (existing.platform !== target.platform) updates.platform = target.platform;
  if (existing.channelId !== target.channelId) updates.channelId = target.channelId;
  if (existing.deliveryMode !== "announce") updates.deliveryMode = "announce";
  if (!existing.enabled) updates.enabled = true;

  if (Object.keys(updates).length === 0) return false;

  await store.updateJob(existing.id, updates);
  log.info({ name: spec.name, updates: Object.keys(updates) }, "Updated job");
  return true;
}

/**
 * Run commitment reminder check.
 * Called by CronEngine or manually.
 */
export async function runCommitmentReminders(): Promise<{
  reminded: number;
  expired: number;
}> {
  const due = await getCommitmentsForReminder();

  if (due.length > 0) {
    const reminders = due
      .map((c) => {
        const deadline = c.deadline ? ` (due: ${c.deadline.toLocaleDateString()})` : "";
        return `- ${c.description}${deadline}`;
      })
      .join("\n");

    log.info(`Commitment reminders:\n${reminders}`);
    await markReminded(due.map((c) => c.id));
  }

  const expired = await expireOverdueCommitments();

  return { reminded: due.length, expired };
}

/**
 * Run daily triage digest.
 * Called by CronEngine or manually.
 */
export async function runTriageDigest(): Promise<string> {
  const triage = await generateTriage(1);

  if (triage.items.length === 0) {
    return "No new messages requiring attention.";
  }

  const lines = ["*Daily triage*\n"];

  const highPriority = triage.items.filter((i) => i.urgency === "high");
  const mediumPriority = triage.items.filter((i) => i.urgency === "medium");

  if (highPriority.length > 0) {
    lines.push("*High priority:*");
    for (const item of highPriority) {
      lines.push(
        `- ${item.contactName ?? item.contact} (${item.platform}): ${item.messageCount} msg(s) — ${item.reason}`,
      );
    }
    lines.push("");
  }

  if (mediumPriority.length > 0) {
    lines.push("*Needs attention:*");
    for (const item of mediumPriority) {
      lines.push(
        `- ${item.contactName ?? item.contact} (${item.platform}): ${item.messageCount} msg(s)`,
      );
    }
  }

  const summary = lines.join("\n");
  log.info(summary);
  return summary;
}
