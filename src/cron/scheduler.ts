import { CronExpressionParser } from "cron-parser";
import type { CronJob } from "./types.ts";
import { createLogger } from "../lib/logger.ts";

const log = createLogger("cron-scheduler");

export type CronCallback = (job: CronJob) => Promise<void>;

export class CronScheduler {
  private timers: Map<string, NodeJS.Timeout> = new Map();
  // job.id -> schedule signature of the currently-armed timer, so the 60s poll
  // can tell an unchanged job (leave its timer) from a changed one (reschedule).
  private scheduled: Map<string, string> = new Map();
  private running: boolean = false;
  private pollInterval: NodeJS.Timeout | null = null;

  constructor(
    private jobs: CronJob[],
    private callback: CronCallback,
    /** Reconcile-poll interval (ms). Lowered in tests so interval jobs can be
     *  exercised in seconds instead of waiting the 60s production cadence. */
    private pollMs: number = 60_000,
  ) {}

  start(): void {
    if (this.running) {
      return;
    }

    this.running = true;
    this.scheduleJobs();

    // Poll to pick up new/changed jobs and re-arm fired ones.
    this.pollInterval = setInterval(() => {
      this.scheduleJobs();
    }, this.pollMs);
  }

  stop(): void {
    this.running = false;

    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }

    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.scheduled.clear();
  }

  updateJobs(jobs: CronJob[]): void {
    this.jobs = jobs;
    this.scheduleJobs();
  }

  private scheduleJobs(): void {
    const enabledJobs = this.jobs.filter((job) => job.enabled);

    // Drop timers for jobs that are gone, disabled, OR whose schedule changed —
    // those need (re)scheduling. Unchanged jobs keep their pending timer; the poll
    // blindly re-creating it every 60s is exactly what reset `every` jobs so they
    // never fired.
    for (const [id, timer] of this.timers.entries()) {
      const job = enabledJobs.find((j) => j.id === id);
      if (!job || this.scheduled.get(id) !== signatureOf(job)) {
        clearTimeout(timer);
        this.timers.delete(id);
        this.scheduled.delete(id);
      }
    }

    // Schedule each enabled job that isn't already armed (scheduleJob skips jobs
    // that still hold a live timer).
    for (const job of enabledJobs) {
      this.scheduleJob(job);
    }
  }

  private scheduleJob(job: CronJob): void {
    // Already armed — leave the pending timer alone. scheduleJobs() drops the timer
    // first when a job is removed/disabled/changed, so reaching here with a live
    // timer means it's unchanged. (Re-creating it on every 60s poll reset `every`
    // jobs' delay before it could elapse, so they never fired.)
    if (this.timers.has(job.id)) {
      return;
    }

    try {
      const nextRun = this.getNextRun(job);
      if (!nextRun) {
        return;
      }

      const delay = nextRun.getTime() - Date.now();
      if (delay < 0) {
        // Past the scheduled time: one-shot "at" jobs run immediately.
        if (job.scheduleType === "at") {
          this.triggerJob(job);
        }
        return;
      }

      const timer = setTimeout(() => {
        // Free the slot BEFORE triggering so the post-run reschedule below isn't
        // skipped by the already-armed guard above.
        this.timers.delete(job.id);
        this.scheduled.delete(job.id);
        this.triggerJob(job);

        // Recurring jobs reschedule from the LATEST definition (picks up edits);
        // "at" jobs are one-shot.
        if (job.scheduleType !== "at") {
          const current = this.jobs.find((j) => j.id === job.id);
          if (current?.enabled) this.scheduleJob(current);
        }
      }, delay);

      this.timers.set(job.id, timer);
      this.scheduled.set(job.id, signatureOf(job));
    } catch (error) {
      log.error({ err: error, jobId: job.id }, "Failed to schedule job");
    }
  }

  private getNextRun(job: CronJob): Date | null {
    switch (job.scheduleType) {
      case "at": {
        const timestamp = new Date(job.schedule);
        if (Number.isNaN(timestamp.getTime())) {
          throw new Error(`Invalid ISO timestamp: ${job.schedule}`);
        }
        return timestamp;
      }

      case "every": {
        const interval = parseInterval(job.schedule);
        // Anchor on a STABLE point (last run, else creation) and step to the next
        // interval boundary after now. `scheduleJobs()` re-runs every 60s and
        // clears+recreates each timer; returning `now + interval` here meant every
        // poll pushed a fresh full interval into the future, so any `every` job
        // with an interval >= the poll period had its timer perpetually reset and
        // NEVER fired. Anchoring yields the same absolute target on every poll (the
        // delay just shrinks toward it), the way `cron` jobs already survive.
        const anchor = (job.lastRun ?? job.createdAt).getTime();
        const periods = Math.max(1, Math.floor((Date.now() - anchor) / interval) + 1);
        return new Date(anchor + periods * interval);
      }

      case "cron": {
        return nextCronRun(job.schedule);
      }

      default:
        throw new Error(`Unknown schedule type: ${job.scheduleType}`);
    }
  }

  private async triggerJob(job: CronJob): Promise<void> {
    try {
      await this.callback(job);
    } catch (error) {
      log.error({ err: error, jobId: job.id }, "Error executing cron job");
    }
  }
}

/** Identity of a job's SCHEDULE — changing it forces a reschedule on the next poll. */
function signatureOf(job: CronJob): string {
  return `${job.scheduleType}:${job.schedule}`;
}

/**
 * Parse interval string like "30m", "1h", "2d" to milliseconds
 */
export function parseInterval(str: string): number {
  const match = str.match(/^(\d+)([smhd])$/);
  if (!match) {
    throw new Error(
      `Invalid interval format: ${str}. Expected format: <number><unit> (e.g., 30m, 1h, 2d)`,
    );
  }

  const value = Number.parseInt(match[1], 10);
  const unit = match[2];

  const multipliers: Record<string, number> = {
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  };

  return value * multipliers[unit];
}

/**
 * Calculate next run time from cron expression
 */
export function nextCronRun(expr: string): Date {
  try {
    const expr_parsed = CronExpressionParser.parse(expr);
    return expr_parsed.next().toDate();
  } catch (error) {
    throw new Error(`Invalid cron expression: ${expr}. Error: ${error}`);
  }
}
