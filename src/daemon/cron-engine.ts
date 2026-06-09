/**
 * Wires the existing CronScheduler into the daemon message queue.
 *
 * When a cron job fires, it creates an IncomingMessage and enqueues it
 * for processing by the AgentRuntime.
 */

import { randomUUID } from "node:crypto";
import { createCronSystem, type CronSystem, type CronJob } from "../cron/index.ts";
import type { MessageQueue } from "./message-queue.ts";
import type { ChannelManager } from "./channel-manager.ts";
import type { AgentEvent } from "./types.ts";
import { createLogger } from "../lib/logger.ts";
import { stripHeartbeatToken } from "../auto-reply/heartbeat.ts";

const log = createLogger("cron-engine");

export class CronEngine {
  private cronSystem: CronSystem | null = null;
  private messageQueue: MessageQueue;
  private channelManager: ChannelManager;
  private broadcast: (event: AgentEvent) => void;

  constructor(
    messageQueue: MessageQueue,
    channelManager: ChannelManager,
    broadcast?: (event: AgentEvent) => void,
  ) {
    this.messageQueue = messageQueue;
    this.channelManager = channelManager;
    this.broadcast = broadcast ?? (() => {});
  }

  /** Initialize and start the cron system. */
  async start(): Promise<void> {
    this.cronSystem = createCronSystem(async (job: CronJob) => {
      await this.handleCronJob(job);
    });

    // Load jobs from DB
    await this.cronSystem.refresh();
    this.cronSystem.start();

    // Listen for refresh events from MCP tools (schedule_task, delete_scheduled_task)
    process.on("cron:refresh" as never, () => {
      this.refresh().catch((err) => log.error({ err }, "Refresh failed"));
    });

    const jobs = await this.cronSystem.store.listJobs({ enabled: true });
    log.info(`Started with ${jobs.length} job(s)`);
  }

  /** Stop the cron system. */
  stop(): void {
    if (this.cronSystem) {
      this.cronSystem.stop();
      this.cronSystem = null;
    }
  }

  /** Refresh jobs from DB (call after adding/removing jobs). */
  async refresh(): Promise<void> {
    if (this.cronSystem) {
      await this.cronSystem.refresh();
    }
  }

  private async handleCronJob(job: CronJob): Promise<void> {
    // Intercept delta-sync sentinel prompts -- route to ingest scheduler
    // instead of the agent message queue.
    if (job.prompt.startsWith("__delta_sync__:")) {
      const platform = job.prompt.slice("__delta_sync__:".length);
      log.info(`Firing delta sync for ${platform}`);
      process.emit("ingest:trigger" as never, { platform, runType: "delta" } as never);
      return;
    }

    // Intercept wiki compilation sentinel -- run compiler directly, once per
    // owner (power-user: just 'local'; hosted: each member's own wiki).
    if (job.prompt === "__wiki_compile__") {
      log.info("Firing wiki compilation");
      (async () => {
        const { compileKnowledge } = await import("../memory/knowledge-compiler.ts");
        const { listMemoryOwners } = await import("../auth/org-members.ts");
        let created = 0;
        let updated = 0;
        for (const userId of await listMemoryOwners()) {
          try {
            const result = await compileKnowledge({ userId });
            created += result.articlesCreated;
            updated += result.articlesUpdated;
          } catch (err) {
            log.error(
              { err: err instanceof Error ? err.message : err, userId },
              "Wiki compilation failed for owner",
            );
          }
        }
        log.info(`Wiki compilation: ${created} created, ${updated} updated`);
      })().catch((err) => {
        log.error({ err: err instanceof Error ? err.message : err }, "Wiki compilation failed");
      });
      return;
    }

    // Intercept auto-dream sentinel -- run background memory consolidation
    // directly (singleton-gated + leased + fans out per owner internally).
    if (job.prompt === "__auto_dream__") {
      log.info("Firing auto-dream consolidation");
      (async () => {
        const { runAutoDreamCycle } = await import("../memory/auto-dream.ts");
        const r = await runAutoDreamCycle();
        if (r) {
          log.info(
            { merged: r.merged, pruned: r.pruned, newChunks: r.newChunks },
            "Auto-dream cycle complete",
          );
        } else {
          log.info("Auto-dream skipped (gate not met or already running)");
        }
      })().catch((err) => {
        log.error({ err: err instanceof Error ? err.message : err }, "Auto-dream failed");
      });
      return;
    }

    // Intercept magic-docs sentinel -- refresh stale self-updating docs.
    if (job.prompt === "__magic_docs__") {
      log.info("Firing magic-docs refresh");
      (async () => {
        const { refreshMagicDocs } = await import("../memory/magic-docs.ts");
        const r = await refreshMagicDocs();
        log.info(
          { scanned: r.scanned, refreshed: r.refreshed, skipped: r.skipped, failed: r.failed },
          "Magic-docs refresh complete",
        );
      })().catch((err) => {
        log.error({ err: err instanceof Error ? err.message : err }, "Magic-docs refresh failed");
      });
      return;
    }

    log.info(`Triggering job: ${job.name} (${job.id})`);

    const sessionKey =
      job.sessionTarget === "isolated" ? `cron:${job.id}:${Date.now()}` : `cron:${job.id}`;

    const incoming = {
      id: randomUUID(),
      platform: job.platform ?? "cron",
      channelId: job.channelId ?? sessionKey,
      userId: job.userId ?? "local",
      content: job.prompt,
      timestamp: new Date(),
    };

    // Broadcast start notification to connected clients
    this.broadcast({
      type: "system",
      subtype: "cron_start",
      message: `Cron job started: ${job.name}`,
      data: { jobId: job.id, jobName: job.name, sessionKey },
    });

    // Record run start
    let runId: string | undefined;
    const startTime = Date.now();
    if (this.cronSystem) {
      try {
        runId = await this.cronSystem.store.recordRunStart(job.id, job.name, sessionKey);
      } catch (err) {
        log.error({ err }, "Failed to record run start");
      }
    }

    try {
      const result = await this.messageQueue.enqueue(sessionKey, incoming, (event) =>
        this.broadcast(event),
      );

      // Suppress the autonomous-loop / heartbeat OK sentinel (the agent is told
      // to reply with EXACTLY AUTONOMOUS_OK / HEARTBEAT_OK on a quiet run).
      // stripHeartbeatToken returns null when the whole reply is just the token.
      const stripped = stripHeartbeatToken(result.content);
      const suppressed = stripped === null;

      // If job has a delivery channel, send the result — but suppress when the
      // agent returned the NOACTION sentinel (inbox/calendar/morning-briefing)
      // or the AUTONOMOUS_OK/HEARTBEAT_OK no-op token.
      if (
        job.deliveryMode === "announce" &&
        job.platform &&
        job.channelId &&
        !suppressed &&
        !result.content.trimStart().startsWith("[NOACTION]")
      ) {
        await this.channelManager.send(result);
      }

      const durationMs = Date.now() - startTime;

      // Broadcast completion to connected clients
      this.broadcast({
        type: "system",
        subtype: "cron_result",
        message: `Cron job completed: ${job.name}`,
        data: {
          jobId: job.id,
          jobName: job.name,
          success: true,
          durationMs,
          // Use the stripped text so the OK sentinel never leaks into the preview.
          contentPreview: (stripped ?? "(no action needed)").slice(0, 500),
        },
      });

      // Mark success
      if (this.cronSystem) {
        await this.cronSystem.store.markRun(job.id, true);
        if (runId) {
          await this.cronSystem.store.recordRunEnd(runId, true, durationMs);
        }
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error({ err: errMsg }, `Job ${job.id} failed`);

      const durationMs = Date.now() - startTime;

      // Broadcast failure to connected clients
      this.broadcast({
        type: "system",
        subtype: "cron_result",
        message: `Cron job failed: ${job.name} — ${errMsg}`,
        data: {
          jobId: job.id,
          jobName: job.name,
          success: false,
          durationMs,
          error: errMsg,
        },
      });

      if (this.cronSystem) {
        await this.cronSystem.store.markRun(job.id, false, errMsg);
        await this.cronSystem.store.disableOnErrors(job.id, 3);
        if (runId) {
          await this.cronSystem.store.recordRunEnd(runId, false, durationMs, errMsg);
        }
      }
    }
  }
}
