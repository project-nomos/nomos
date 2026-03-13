export type ScheduleType = "at" | "every" | "cron";

export type SessionTarget = "main" | "isolated";

export type DeliveryMode = "none" | "announce";

export interface CronJob {
  id: string;
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
}
