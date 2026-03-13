import { CronExpressionParser } from "cron-parser";
import type { CronJob } from "./types.ts";

export type CronCallback = (job: CronJob) => Promise<void>;

export class CronScheduler {
  private timers: Map<string, NodeJS.Timeout> = new Map();
  private running: boolean = false;
  private pollInterval: NodeJS.Timeout | null = null;

  constructor(
    private jobs: CronJob[],
    private callback: CronCallback,
  ) {}

  start(): void {
    if (this.running) {
      return;
    }

    this.running = true;
    this.scheduleJobs();

    // Poll every minute to pick up new jobs or reschedule
    this.pollInterval = setInterval(() => {
      this.scheduleJobs();
    }, 60000);
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
  }

  updateJobs(jobs: CronJob[]): void {
    this.jobs = jobs;
    this.scheduleJobs();
  }

  private scheduleJobs(): void {
    const enabledJobs = this.jobs.filter((job) => job.enabled);

    // Remove timers for jobs that are no longer enabled or don't exist
    for (const [id, timer] of this.timers.entries()) {
      if (!enabledJobs.some((job) => job.id === id)) {
        clearTimeout(timer);
        this.timers.delete(id);
      }
    }

    // Schedule each enabled job
    for (const job of enabledJobs) {
      this.scheduleJob(job);
    }
  }

  private scheduleJob(job: CronJob): void {
    // Clear existing timer if any
    const existingTimer = this.timers.get(job.id);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    try {
      const nextRun = this.getNextRun(job);
      if (!nextRun) {
        return;
      }

      const delay = nextRun.getTime() - Date.now();
      if (delay < 0) {
        // If we're past the scheduled time, run immediately for "at" jobs
        if (job.scheduleType === "at") {
          this.triggerJob(job);
        }
        return;
      }

      const timer = setTimeout(() => {
        this.triggerJob(job);

        // For "every" and "cron" jobs, reschedule after execution
        if (job.scheduleType !== "at") {
          this.scheduleJob(job);
        } else {
          this.timers.delete(job.id);
        }
      }, delay);

      this.timers.set(job.id, timer);
    } catch (error) {
      console.error(`Failed to schedule job ${job.id}:`, error);
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
        return new Date(Date.now() + interval);
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
      console.error(`Error executing cron job ${job.id}:`, error);
    }
  }
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
