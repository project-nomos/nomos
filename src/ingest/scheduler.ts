/**
 * Ingestion scheduler: centralizes lifecycle management for ingest jobs.
 *
 * Replaces the ad-hoc triggerInitialIngest / spawnIngestSubprocess logic
 * previously scattered in Gateway. Enforces invariants:
 *   - A delta sync never starts if the full ingest hasn't completed.
 *   - A second run of the same type never starts while one is running.
 *   - All subprocess spawns are serialized through a queue to respect
 *     API rate limits.
 *   - Auto-triggered full ingests default to the last 30 days (not all
 *     history) to avoid hammering rate-limited APIs.
 */

import { getIngestJobByPlatform, getLastCompletedJob } from "./pipeline.ts";

/** Default lookback for auto-triggered full ingests (30 days). */
const DEFAULT_LOOKBACK_DAYS = 30;

export type SpawnFn = (subcommand: string, extraArgs: string[], label: string) => Promise<void>;

export class IngestScheduler {
  private ingestQueue: Promise<void> = Promise.resolve();
  private spawnFn: SpawnFn;

  constructor(spawnFn: SpawnFn) {
    this.spawnFn = spawnFn;
  }

  /**
   * Trigger a full (initial) ingest for a platform.
   * Skips if a full ingest is already completed or running.
   */
  triggerFull(platform: string, sourceType: string, subcommand: string): void {
    this.enqueue(async () => {
      const existing = await getIngestJobByPlatform(platform, sourceType, "full");
      if (existing && (existing.status === "completed" || existing.status === "running")) {
        return;
      }
      const since = new Date();
      since.setDate(since.getDate() - DEFAULT_LOOKBACK_DAYS);
      console.log(
        `[ingest-scheduler] Starting full ingest for ${platform} (last ${DEFAULT_LOOKBACK_DAYS} days)`,
      );
      await this.spawnFn(
        subcommand,
        ["--run-type", "full", "--since", since.toISOString()],
        platform,
      );
    });
  }

  /**
   * Trigger a delta (incremental) sync for a platform.
   * Prerequisite: a full ingest must have completed.
   * Uses the last completed job's timestamp as the --since filter.
   */
  triggerDelta(platform: string, sourceType: string, subcommand: string): void {
    this.enqueue(async () => {
      // Don't start delta if full hasn't completed
      const fullJob = await getIngestJobByPlatform(platform, sourceType, "full");
      if (!fullJob || fullJob.status !== "completed") {
        console.log(
          `[ingest-scheduler] Skipping delta for ${platform} -- full ingest not completed`,
        );
        return;
      }

      // Don't start if a delta is already running
      const deltaJob = await getIngestJobByPlatform(platform, sourceType, "delta");
      if (deltaJob?.status === "running") {
        return;
      }

      // Compute --since from last completed job (any type)
      const lastCompleted = await getLastCompletedJob(platform, sourceType);
      const extraArgs = ["--run-type", "delta"];
      if (lastCompleted?.last_successful_at) {
        extraArgs.push("--since", new Date(lastCompleted.last_successful_at).toISOString());
      }

      console.log(`[ingest-scheduler] Starting delta sync for ${platform}`);
      await this.spawnFn(subcommand, extraArgs, `${platform} (delta)`);
    });
  }

  /**
   * Trigger a full ingest, or delta if full already completed.
   * Convenience method for "do the right thing" calls.
   */
  triggerAuto(platform: string, sourceType: string, subcommand: string): void {
    this.enqueue(async () => {
      const fullJob = await getIngestJobByPlatform(platform, sourceType, "full");
      if (fullJob?.status === "completed") {
        // Full done -- run delta instead
        this.triggerDelta(platform, sourceType, subcommand);
      } else if (fullJob?.status === "running") {
        // Already running -- skip
      } else {
        this.triggerFull(platform, sourceType, subcommand);
      }
    });
  }

  /**
   * Map a platform identifier to its CLI subcommand.
   * e.g. "slack:T123" -> "slack", "gmail" -> "gmail"
   */
  static platformToSubcommand(platform: string): string | null {
    if (platform.startsWith("slack:")) return "slack";
    if (platform === "gmail") return "gmail";
    if (platform === "discord") return "discord";
    if (platform === "telegram") return "telegram";
    if (platform === "imessage") return "imessage";
    if (platform === "whatsapp") return "whatsapp";
    return null;
  }

  private enqueue(task: () => Promise<void>): void {
    this.ingestQueue = this.ingestQueue.then(task).catch((err) => {
      console.error("[ingest-scheduler] Task failed:", err);
    });
  }
}
