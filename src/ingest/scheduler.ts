/**
 * Ingestion scheduler: centralizes lifecycle management for ingest jobs.
 *
 * Enforces invariants:
 *   - A full ingest only runs once per platform (skip if completed, running, or recently failed).
 *   - Delta syncs have a minimum cooldown (1 hour) to prevent flooding on restart.
 *   - All subprocess spawns are serialized through a queue.
 *   - Auto-triggered full ingests default to the last 30 days.
 *   - Deduplicates Slack triggers (CLI ingests all workspaces in one run).
 */

import { getIngestJobByPlatform, getLastCompletedJob } from "./pipeline.ts";

/** Default lookback for auto-triggered full ingests (30 days). */
const DEFAULT_LOOKBACK_DAYS = 30;

/** Minimum time between delta syncs for the same platform (1 hour). */
const DELTA_COOLDOWN_MS = 60 * 60 * 1000;

/** Minimum time before retrying a failed full ingest (1 hour). */
const FAILED_RETRY_COOLDOWN_MS = 60 * 60 * 1000;

export type SpawnFn = (subcommand: string, extraArgs: string[], label: string) => Promise<void>;

export class IngestScheduler {
  private ingestQueue: Promise<void> = Promise.resolve();
  private spawnFn: SpawnFn;

  /** Track which CLI subcommands have already been triggered this session
   *  to avoid spawning duplicate processes (e.g., `nomos ingest slack`
   *  ingests ALL workspaces, so triggering per-workspace is redundant). */
  private triggeredSubcommands = new Set<string>();

  constructor(spawnFn: SpawnFn) {
    this.spawnFn = spawnFn;
  }

  /**
   * Trigger a full (initial) ingest for a platform.
   * Skips if a full ingest is already completed, running, or recently failed.
   */
  triggerFull(platform: string, sourceType: string, subcommand: string): void {
    this.enqueue(async () => {
      const existing = await getIngestJobByPlatform(platform, sourceType, "full");
      if (existing) {
        if (existing.status === "completed" || existing.status === "running") return;
        // Don't retry failed ingests within the cooldown period
        if (existing.status === "failed" && existing.finished_at) {
          const elapsed = Date.now() - new Date(existing.finished_at).getTime();
          if (elapsed < FAILED_RETRY_COOLDOWN_MS) return;
        }
      }

      // Deduplicate: `nomos ingest slack` ingests all workspaces in one run
      const dedupeKey = `full:${subcommand}`;
      if (this.triggeredSubcommands.has(dedupeKey)) return;
      this.triggeredSubcommands.add(dedupeKey);

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
   * Respects a cooldown to prevent flooding on restart.
   */
  triggerDelta(platform: string, sourceType: string, subcommand: string): void {
    this.enqueue(async () => {
      // Don't start delta if full hasn't completed
      const fullJob = await getIngestJobByPlatform(platform, sourceType, "full");
      if (!fullJob || fullJob.status !== "completed") {
        return;
      }

      // Don't start if a delta is already running
      const deltaJob = await getIngestJobByPlatform(platform, sourceType, "delta");
      if (deltaJob?.status === "running") return;

      // Cooldown: don't run if a delta completed recently
      if (deltaJob?.status === "completed" && deltaJob.finished_at) {
        const elapsed = Date.now() - new Date(deltaJob.finished_at).getTime();
        if (elapsed < DELTA_COOLDOWN_MS) return;
      }

      // Deduplicate: same subcommand = same process
      const dedupeKey = `delta:${subcommand}`;
      if (this.triggeredSubcommands.has(dedupeKey)) return;
      this.triggeredSubcommands.add(dedupeKey);

      // Compute --since from last completed job (any type)
      const lastCompleted = await getLastCompletedJob(platform, sourceType);
      const extraArgs = ["--run-type", "delta"];
      if (lastCompleted?.last_successful_at) {
        extraArgs.push("--since", new Date(lastCompleted.last_successful_at).toISOString());
      }

      console.log(`[ingest-scheduler] Starting delta sync for ${platform}`);
      await this.spawnFn(subcommand, extraArgs, `${platform} (delta)`);

      // Clear dedupe after completion so cron-triggered deltas still work later
      this.triggeredSubcommands.delete(dedupeKey);
    });
  }

  /**
   * Trigger a full ingest, or delta if full already completed.
   * Use for explicit user actions (Settings UI save, gRPC command).
   * If no full ingest exists yet, runs a full. Otherwise runs a delta.
   */
  triggerAuto(platform: string, sourceType: string, subcommand: string): void {
    this.enqueue(async () => {
      const fullJob = await getIngestJobByPlatform(platform, sourceType, "full");
      if (fullJob?.status === "completed") {
        this.triggerDelta(platform, sourceType, subcommand);
      } else if (fullJob?.status === "running") {
        // Already running -- skip
      } else {
        this.triggerFull(platform, sourceType, subcommand);
      }
    });
  }

  /**
   * Startup sync: only run a delta if a full ingest has already completed.
   * Never triggers a full ingest -- that only happens when the user explicitly
   * adds an integration (via Settings UI or gRPC command).
   */
  triggerStartup(platform: string, sourceType: string, subcommand: string): void {
    this.enqueue(async () => {
      const fullJob = await getIngestJobByPlatform(platform, sourceType, "full");
      if (fullJob?.status === "completed") {
        this.triggerDelta(platform, sourceType, subcommand);
      }
      // No full ingest exists or it failed -- do nothing on startup.
      // User must explicitly trigger via Settings UI or CLI.
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
