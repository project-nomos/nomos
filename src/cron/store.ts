import { sql } from "kysely";
import { randomUUID } from "node:crypto";
import { getKysely } from "../db/client.ts";
import type { CronJob, CronJobUpdate, CronJobFilter, CronRun, CronRunFilter } from "./types.ts";

interface CronJobRow {
  id: string;
  name: string;
  schedule: string;
  schedule_type: string;
  session_target: string;
  delivery_mode: string;
  prompt: string;
  platform: string | null;
  channel_id: string | null;
  enabled: boolean;
  error_count: number;
  last_run: Date | null;
  last_error: string | null;
  created_at: Date;
}

export class CronStore {
  private rowToJob(row: CronJobRow): CronJob {
    return {
      id: row.id,
      name: row.name,
      schedule: row.schedule,
      scheduleType: row.schedule_type as CronJob["scheduleType"],
      sessionTarget: row.session_target as CronJob["sessionTarget"],
      deliveryMode: row.delivery_mode as CronJob["deliveryMode"],
      prompt: row.prompt,
      platform: row.platform ?? undefined,
      channelId: row.channel_id ?? undefined,
      enabled: row.enabled,
      errorCount: row.error_count,
      lastRun: row.last_run ?? undefined,
      lastError: row.last_error ?? undefined,
      createdAt: row.created_at,
    };
  }

  async createJob(job: Omit<CronJob, "id" | "createdAt">): Promise<string> {
    const db = getKysely();
    const id = randomUUID();
    await db
      .insertInto("cron_jobs")
      .values({
        id,
        name: job.name,
        schedule: job.schedule,
        schedule_type: job.scheduleType,
        session_target: job.sessionTarget,
        delivery_mode: job.deliveryMode,
        prompt: job.prompt,
        platform: job.platform ?? null,
        channel_id: job.channelId ?? null,
        enabled: job.enabled,
        error_count: job.errorCount,
      })
      .execute();
    return id;
  }

  async updateJob(id: string, updates: CronJobUpdate): Promise<void> {
    const db = getKysely();

    const setValues: Record<string, unknown> = {};
    if (updates.name !== undefined) setValues.name = updates.name;
    if (updates.schedule !== undefined) setValues.schedule = updates.schedule;
    if (updates.scheduleType !== undefined) setValues.schedule_type = updates.scheduleType;
    if (updates.sessionTarget !== undefined) setValues.session_target = updates.sessionTarget;
    if (updates.deliveryMode !== undefined) setValues.delivery_mode = updates.deliveryMode;
    if (updates.prompt !== undefined) setValues.prompt = updates.prompt;
    if (updates.platform !== undefined) setValues.platform = updates.platform;
    if (updates.channelId !== undefined) setValues.channel_id = updates.channelId;
    if (updates.enabled !== undefined) setValues.enabled = updates.enabled;
    if (updates.errorCount !== undefined) setValues.error_count = updates.errorCount;
    if (updates.lastRun !== undefined) setValues.last_run = updates.lastRun;
    if (updates.lastError !== undefined) setValues.last_error = updates.lastError;

    if (Object.keys(setValues).length === 0) return;

    await db.updateTable("cron_jobs").set(setValues).where("id", "=", id).execute();
  }

  async deleteJob(id: string): Promise<void> {
    const db = getKysely();
    await db.deleteFrom("cron_jobs").where("id", "=", id).execute();
  }

  async getJob(id: string): Promise<CronJob | null> {
    const db = getKysely();
    const row = await db
      .selectFrom("cron_jobs")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    return row ? this.rowToJob(row as unknown as CronJobRow) : null;
  }

  async getJobByName(name: string): Promise<CronJob | null> {
    const db = getKysely();
    const row = await db
      .selectFrom("cron_jobs")
      .selectAll()
      .where("name", "=", name)
      .executeTakeFirst();
    return row ? this.rowToJob(row as unknown as CronJobRow) : null;
  }

  async listJobs(filter?: CronJobFilter): Promise<CronJob[]> {
    const db = getKysely();
    let query = db.selectFrom("cron_jobs").selectAll();

    if (filter?.enabled !== undefined) {
      query = query.where("enabled", "=", filter.enabled);
    }
    if (filter?.platform !== undefined) {
      query = query.where("platform", "=", filter.platform);
    }
    if (filter?.sessionTarget !== undefined) {
      query = query.where("session_target", "=", filter.sessionTarget);
    }

    const rows = await query.execute();
    return rows.map((row) => this.rowToJob(row as unknown as CronJobRow));
  }

  async markRun(id: string, success: boolean, error?: string): Promise<void> {
    const db = getKysely();
    if (success) {
      await db
        .updateTable("cron_jobs")
        .set({ last_run: sql`now()`, error_count: 0, last_error: null })
        .where("id", "=", id)
        .execute();
    } else {
      await db
        .updateTable("cron_jobs")
        .set({
          last_run: sql`now()`,
          error_count: sql`error_count + 1`,
          last_error: error ?? null,
        })
        .where("id", "=", id)
        .execute();
    }
  }

  async disableOnErrors(id: string, maxErrors: number = 3): Promise<void> {
    const db = getKysely();
    await db
      .updateTable("cron_jobs")
      .set({ enabled: false })
      .where("id", "=", id)
      .where("error_count", ">=", maxErrors)
      .execute();
  }

  // --- Cron run history ---

  async recordRunStart(jobId: string, jobName: string, sessionKey: string): Promise<string> {
    const db = getKysely();
    const id = randomUUID();
    await db
      .insertInto("cron_runs")
      .values({
        id,
        job_id: jobId,
        job_name: jobName,
        success: false,
        session_key: sessionKey,
      })
      .execute();
    return id;
  }

  async recordRunEnd(
    runId: string,
    success: boolean,
    durationMs: number,
    error?: string,
  ): Promise<void> {
    const db = getKysely();
    await db
      .updateTable("cron_runs")
      .set({
        finished_at: sql`now()`,
        success,
        duration_ms: durationMs,
        error: error ?? null,
      })
      .where("id", "=", runId)
      .execute();
  }

  async listRuns(filter?: CronRunFilter): Promise<CronRun[]> {
    const db = getKysely();
    const limit = filter?.limit ?? 50;

    let query = db.selectFrom("cron_runs").selectAll();

    if (filter?.jobId) {
      query = query.where("job_id", "=", filter.jobId);
    }
    if (filter?.success !== undefined) {
      query = query.where("success", "=", filter.success);
    }

    const rows = await query.orderBy("started_at", "desc").limit(limit).execute();
    return rows.map((row) => this.rowToRun(row as unknown as CronRunRow));
  }

  async getRunStats(jobId: string): Promise<{
    totalRuns: number;
    successCount: number;
    failureCount: number;
    avgDurationMs: number | null;
    lastRun: Date | null;
  }> {
    const db = getKysely();
    const row = await db
      .selectFrom("cron_runs")
      .select([
        sql<number>`count(*)::int`.as("total"),
        sql<number>`count(*) FILTER (WHERE success = true)::int`.as("successes"),
        sql<number>`count(*) FILTER (WHERE success = false AND finished_at IS NOT NULL)::int`.as(
          "failures",
        ),
        sql<number | null>`avg(duration_ms) FILTER (WHERE duration_ms IS NOT NULL)::int`.as(
          "avg_duration",
        ),
        sql<Date | null>`max(started_at)`.as("last_run"),
      ])
      .where("job_id", "=", jobId)
      .executeTakeFirstOrThrow();

    return {
      totalRuns: row.total,
      successCount: row.successes,
      failureCount: row.failures,
      avgDurationMs: row.avg_duration,
      lastRun: row.last_run,
    };
  }

  async pruneOldRuns(retentionDays: number = 30): Promise<number> {
    const db = getKysely();
    const result = await db
      .deleteFrom("cron_runs")
      .where("started_at", "<", sql<Date>`now() - interval '1 day' * ${retentionDays}`)
      .executeTakeFirst();
    return Number(result.numDeletedRows ?? 0n);
  }

  private rowToRun(row: CronRunRow): CronRun {
    return {
      id: row.id,
      jobId: row.job_id,
      jobName: row.job_name,
      startedAt: row.started_at,
      finishedAt: row.finished_at ?? undefined,
      success: row.success,
      error: row.error ?? undefined,
      durationMs: row.duration_ms ?? undefined,
      sessionKey: row.session_key ?? undefined,
    };
  }
}

interface CronRunRow {
  id: string;
  job_id: string;
  job_name: string;
  started_at: Date;
  finished_at: Date | null;
  success: boolean;
  error: string | null;
  duration_ms: number | null;
  session_key: string | null;
}
