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
import { generateTriage, type TriageSummary } from "./priority-triage.ts";
import { inboxScanJobSpec, type ProactiveJobSpec } from "./inbox-watcher.ts";
import { calendarScanJobSpec } from "./calendar-watcher.ts";
import { morningBriefingJobSpec, DEFAULT_BRIEFING_CRON } from "./morning-briefing.ts";
import { loadEnvConfigAsync } from "../config/env.ts";
import { getNotificationDefault } from "../db/notification-defaults.ts";
import { isHosted } from "../config/mode.ts";
import { createLogger } from "../lib/logger.ts";

const log = createLogger("proactive-scheduler");

const INBOX_JOB_NAME = "proactive:inbox-watcher";
const CALENDAR_JOB_NAME = "proactive:calendar-watcher";
const BRIEFING_JOB_NAME = "proactive:morning-briefing";
const COMMITMENT_JOB_NAME = "proactive:commitment-reminders";
const TRIAGE_JOB_NAME = "proactive:triage-digest";

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

  // Commitment reminders are gated on the commitmentTracking switch (the same
  // switch that gates capture in the indexer), INDEPENDENT of inbox autonomy --
  // capture-without-autonomy is still useful. Delivery needs a notification target;
  // in hosted mode that's each owner's mobile push, resolved per-owner when the
  // sentinel fans out, so a global `target` isn't required there.
  changed =
    (await syncSentinelJob(store, {
      name: COMMITMENT_JOB_NAME,
      prompt: "__commitment_reminders__",
      schedule: "1h",
      scheduleType: "every",
      enabled: Boolean(config.commitmentTracking && (target || isHosted())),
    })) || changed;

  if (autonomy === "off") {
    // Disable the autonomy-gated jobs (don't delete — preserve run history).
    // Commitment reminders are NOT in this list (they follow commitmentTracking).
    for (const name of [INBOX_JOB_NAME, CALENDAR_JOB_NAME, BRIEFING_JOB_NAME, TRIAGE_JOB_NAME]) {
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
    if (changed) process.emit("cron:refresh" as never);
    return;
  }

  // Upsert each job. The cron engine routes the prompt through AgentRuntime
  // (which has google-workspace MCP + DraftManager); `announce` mode posts
  // the agent's reply to the default channel.
  changed = (await upsertJob(store, inboxScanJobSpec(autonomy, inboxInterval), target)) || changed;
  changed = (await upsertJob(store, calendarScanJobSpec(calendarInterval), target)) || changed;
  changed = (await upsertJob(store, morningBriefingJobSpec(briefingCron), target)) || changed;

  // Daily triage digest -- gated on inbox autonomy (reads ingested inbox msgs).
  // Code-dispatched sentinel (delivered in-handler), not an agent turn.
  changed =
    (await syncSentinelJob(store, {
      name: TRIAGE_JOB_NAME,
      prompt: "__triage_digest__",
      schedule: "0 17 * * *",
      scheduleType: "cron",
      enabled: true,
    })) || changed;

  if (changed) process.emit("cron:refresh" as never);
}

/**
 * Create/enable/disable a code-dispatched sentinel cron job (one handled
 * directly by CronEngine, not enqueued as an agent turn). Idempotent: creates
 * when missing+wanted, flips `enabled` to match `opts.enabled` otherwise.
 * Returns true when it changed anything (so the caller emits cron:refresh).
 */
async function syncSentinelJob(
  store: CronStore,
  opts: {
    name: string;
    prompt: string;
    schedule: string;
    scheduleType: "every" | "cron";
    enabled: boolean;
  },
): Promise<boolean> {
  const existing = await store.getJobByName(opts.name);
  if (!existing) {
    if (!opts.enabled) return false;
    await store.createJob({
      userId: systemTenant().userId,
      name: opts.name,
      schedule: opts.schedule,
      scheduleType: opts.scheduleType,
      sessionTarget: "isolated",
      deliveryMode: "none", // delivery happens in the cron-engine handler
      prompt: opts.prompt,
      enabled: true,
      errorCount: 0,
    });
    log.info({ name: opts.name, schedule: opts.schedule }, "Registered sentinel job");
    return true;
  }
  if (existing.enabled !== opts.enabled) {
    await store.updateJob(existing.id, { enabled: opts.enabled });
    log.info({ name: opts.name, enabled: opts.enabled }, "Toggled sentinel job");
    return true;
  }
  return false;
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
 * Run the commitment reminder check, returning one deliverable text block per
 * owner that has due reminders (the cron-engine handler sends each). Also marks
 * those reminded and expires overdue commitments. Called by CronEngine or
 * manually.
 *
 * Per-owner: power-user is just 'local'; a hosted multi-member DB reminds each
 * member about their own commitments.
 */
export async function runCommitmentReminders(): Promise<Array<{ userId: string; text: string }>> {
  const { listMemoryOwners } = await import("../auth/org-members.ts");
  const out: Array<{ userId: string; text: string }> = [];

  for (const userId of await listMemoryOwners()) {
    const due = await getCommitmentsForReminder(userId);

    if (due.length > 0) {
      const reminders = due
        .map((c) => {
          const deadline = c.deadline ? ` (due: ${c.deadline.toLocaleDateString()})` : "";
          return `- ${c.description}${deadline}`;
        })
        .join("\n");

      out.push({ userId, text: `*Commitment reminders*\n${reminders}` });
      await markReminded(
        userId,
        due.map((c) => c.id),
      );
    }

    await expireOverdueCommitments(userId);
  }

  return out;
}

/** Format a triage summary into a deliverable digest, or null on a quiet day. */
function formatTriage(triage: TriageSummary): string | null {
  if (triage.items.length === 0) return null;

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

  return lines.join("\n");
}

/**
 * Run the daily triage digest per owner, returning one deliverable text block per
 * owner that has anything to report (quiet owners are omitted). The cron handler
 * delivers each to that owner's notification channel. Called by CronEngine or
 * manually.
 */
export async function runTriageDigest(): Promise<Array<{ userId: string; text: string }>> {
  const { listMemoryOwners } = await import("../auth/org-members.ts");
  const out: Array<{ userId: string; text: string }> = [];

  for (const userId of await listMemoryOwners()) {
    const text = formatTriage(await generateTriage(userId, 1));
    if (text) {
      out.push({ userId, text });
      log.info({ userId }, "Triage digest");
    }
  }

  return out;
}
