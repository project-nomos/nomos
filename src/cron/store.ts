import type postgres from "postgres";
import { randomUUID } from "node:crypto";
import type { CronJob, CronJobUpdate, CronJobFilter } from "./types.ts";

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
  constructor(private sql: postgres.Sql) {}

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
    const id = randomUUID();
    const [row] = await this.sql<CronJobRow[]>`
      INSERT INTO cron_jobs (
        id, name, schedule, schedule_type, session_target, delivery_mode,
        prompt, platform, channel_id, enabled, error_count
      )
      VALUES (
        ${id},
        ${job.name},
        ${job.schedule},
        ${job.scheduleType},
        ${job.sessionTarget},
        ${job.deliveryMode},
        ${job.prompt},
        ${job.platform ?? null},
        ${job.channelId ?? null},
        ${job.enabled},
        ${job.errorCount}
      )
      RETURNING *
    `;
    return row.id;
  }

  async updateJob(id: string, updates: CronJobUpdate): Promise<void> {
    const updateFields: string[] = [];
    const values: (string | number | boolean | Date | null)[] = [];

    if (updates.name !== undefined) {
      updateFields.push(`name = $${values.length + 1}`);
      values.push(updates.name);
    }
    if (updates.schedule !== undefined) {
      updateFields.push(`schedule = $${values.length + 1}`);
      values.push(updates.schedule);
    }
    if (updates.scheduleType !== undefined) {
      updateFields.push(`schedule_type = $${values.length + 1}`);
      values.push(updates.scheduleType);
    }
    if (updates.sessionTarget !== undefined) {
      updateFields.push(`session_target = $${values.length + 1}`);
      values.push(updates.sessionTarget);
    }
    if (updates.deliveryMode !== undefined) {
      updateFields.push(`delivery_mode = $${values.length + 1}`);
      values.push(updates.deliveryMode);
    }
    if (updates.prompt !== undefined) {
      updateFields.push(`prompt = $${values.length + 1}`);
      values.push(updates.prompt);
    }
    if (updates.platform !== undefined) {
      updateFields.push(`platform = $${values.length + 1}`);
      values.push(updates.platform);
    }
    if (updates.channelId !== undefined) {
      updateFields.push(`channel_id = $${values.length + 1}`);
      values.push(updates.channelId);
    }
    if (updates.enabled !== undefined) {
      updateFields.push(`enabled = $${values.length + 1}`);
      values.push(updates.enabled);
    }
    if (updates.errorCount !== undefined) {
      updateFields.push(`error_count = $${values.length + 1}`);
      values.push(updates.errorCount);
    }
    if (updates.lastRun !== undefined) {
      updateFields.push(`last_run = $${values.length + 1}`);
      values.push(updates.lastRun);
    }
    if (updates.lastError !== undefined) {
      updateFields.push(`last_error = $${values.length + 1}`);
      values.push(updates.lastError);
    }

    if (updateFields.length === 0) {
      return;
    }

    values.push(id);
    await this.sql.unsafe(
      `UPDATE cron_jobs SET ${updateFields.join(", ")} WHERE id = $${values.length}`,
      values,
    );
  }

  async deleteJob(id: string): Promise<void> {
    await this.sql`DELETE FROM cron_jobs WHERE id = ${id}`;
  }

  async getJob(id: string): Promise<CronJob | null> {
    const [row] = await this.sql<CronJobRow[]>`
      SELECT * FROM cron_jobs WHERE id = ${id}
    `;
    return row ? this.rowToJob(row) : null;
  }

  async getJobByName(name: string): Promise<CronJob | null> {
    const [row] = await this.sql<CronJobRow[]>`
      SELECT * FROM cron_jobs WHERE name = ${name}
    `;
    return row ? this.rowToJob(row) : null;
  }

  async listJobs(filter?: CronJobFilter): Promise<CronJob[]> {
    let query = this.sql<CronJobRow[]>`SELECT * FROM cron_jobs WHERE true`;

    if (filter?.enabled !== undefined) {
      query = this.sql<CronJobRow[]>`
        SELECT * FROM cron_jobs WHERE enabled = ${filter.enabled}
      `;
    }

    if (filter?.platform !== undefined) {
      query = this.sql<CronJobRow[]>`
        SELECT * FROM cron_jobs WHERE enabled = ${filter.enabled ?? true} AND platform = ${filter.platform}
      `;
    }

    if (filter?.sessionTarget !== undefined) {
      query = this.sql<CronJobRow[]>`
        SELECT * FROM cron_jobs
        WHERE enabled = ${filter.enabled ?? true}
        AND session_target = ${filter.sessionTarget}
        ${filter.platform ? this.sql`AND platform = ${filter.platform}` : this.sql``}
      `;
    }

    const rows = await query;
    return rows.map((row) => this.rowToJob(row));
  }

  async markRun(id: string, success: boolean, error?: string): Promise<void> {
    if (success) {
      await this.sql`
        UPDATE cron_jobs SET
          last_run = now(),
          error_count = 0,
          last_error = null
        WHERE id = ${id}
      `;
    } else {
      await this.sql`
        UPDATE cron_jobs SET
          last_run = now(),
          error_count = error_count + 1,
          last_error = ${error ?? null}
        WHERE id = ${id}
      `;
    }
  }

  async disableOnErrors(id: string, maxErrors: number = 3): Promise<void> {
    await this.sql`
      UPDATE cron_jobs SET enabled = false
      WHERE id = ${id} AND error_count >= ${maxErrors}
    `;
  }
}
