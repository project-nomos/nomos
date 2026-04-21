/**
 * Delta sync: registers cron jobs for continuous ingestion.
 *
 * After an initial full ingest completes, a cron job is created to
 * periodically trigger a delta (incremental) sync via the IngestScheduler.
 * The cron job uses a `__delta_sync__:<platform>` sentinel prompt that
 * the cron engine intercepts and routes to the gateway's ingest:trigger
 * process event.
 */

import { getKysely } from "../db/client.ts";
import { CronStore } from "../cron/store.ts";

/**
 * Register delta sync cron jobs for all platforms with completed full ingests.
 * Called during daemon startup and after each successful ingest subprocess.
 * Idempotent -- skips platforms that already have a cron job registered.
 */
export async function registerDeltaSyncJobs(): Promise<void> {
  const db = getKysely();

  // Find all platforms with completed full ingests and delta enabled
  const jobs = await db
    .selectFrom("ingest_jobs")
    .select(["platform", "source_type", "delta_schedule"])
    .where("status", "=", "completed")
    .where("run_type", "=", "full")
    .where("delta_enabled", "=", true)
    .execute();

  if (jobs.length === 0) return;

  const store = new CronStore();

  for (const job of jobs) {
    const cronName = `delta-sync:${job.platform}`;
    const existing = await store.getJobByName(cronName);

    if (existing) {
      // Update schedule if it changed
      const schedule = job.delta_schedule || "6h";
      if (existing.schedule !== schedule) {
        await store.updateJob(existing.id, { schedule });
        console.log(`[delta-sync] Updated schedule for ${cronName}: ${schedule}`);
      }
      continue;
    }

    await store.createJob({
      name: cronName,
      schedule: job.delta_schedule || "6h",
      scheduleType: "every",
      sessionTarget: "isolated",
      deliveryMode: "none",
      prompt: `__delta_sync__:${job.platform}`,
      enabled: true,
      errorCount: 0,
    });

    console.log(
      `[delta-sync] Registered cron job: ${cronName} every ${job.delta_schedule || "6h"}`,
    );
  }

  // Signal the cron engine to reload jobs
  process.emit("cron:refresh" as never);
}
