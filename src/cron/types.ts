export type ScheduleType = "at" | "every" | "cron";

export type SessionTarget = "main" | "isolated";

export type DeliveryMode = "none" | "announce";

/** Provenance: system (infra crons) | bundled (LOOP.md examples) | user (CLI/UI) | agent (self-authored). */
export type CronJobSource = "system" | "bundled" | "user" | "agent";

export interface CronJob {
  id: string;
  /** Owner of the scheduled task; becomes the vault/memory owner when it runs. */
  userId: string;
  name: string;
  schedule: string;
  scheduleType: ScheduleType;
  sessionTarget: SessionTarget;
  deliveryMode: DeliveryMode;
  prompt: string;
  platform?: string;
  channelId?: string;
  enabled: boolean;
  errorCount: number;
  lastRun?: Date;
  lastError?: string;
  createdAt: Date;
  source?: CronJobSource;
}

export interface CronJobUpdate {
  name?: string;
  schedule?: string;
  scheduleType?: ScheduleType;
  sessionTarget?: SessionTarget;
  deliveryMode?: DeliveryMode;
  prompt?: string;
  platform?: string;
  channelId?: string;
  enabled?: boolean;
  errorCount?: number;
  lastRun?: Date;
  lastError?: string;
}

export interface CronJobFilter {
  enabled?: boolean;
  platform?: string;
  sessionTarget?: SessionTarget;
  /** Scope to one owner (the loop's user_id). Omit for all owners. */
  userId?: string;
  source?: CronJobSource;
}

export interface CronRun {
  id: string;
  jobId: string;
  jobName: string;
  startedAt: Date;
  finishedAt?: Date;
  success: boolean;
  error?: string;
  durationMs?: number;
  sessionKey?: string;
}

export interface CronRunFilter {
  jobId?: string;
  success?: boolean;
  limit?: number;
}
