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
      this.refresh().catch((err) => console.error("[cron-engine] Refresh failed:", err));
    });

    const jobs = await this.cronSystem.store.listJobs({ enabled: true });
    console.log(`[cron-engine] Started with ${jobs.length} job(s)`);
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
      console.log(`[cron-engine] Firing delta sync for ${platform}`);
      process.emit("ingest:trigger" as never, { platform, runType: "delta" } as never);
      return;
    }

    console.log(`[cron-engine] Triggering job: ${job.name} (${job.id})`);

    const sessionKey =
      job.sessionTarget === "isolated" ? `cron:${job.id}:${Date.now()}` : `cron:${job.id}`;

    const incoming = {
      id: randomUUID(),
      platform: job.platform ?? "cron",
      channelId: job.channelId ?? sessionKey,
      userId: "cron-scheduler",
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
        console.error("[cron-engine] Failed to record run start:", err);
      }
    }

    try {
      const result = await this.messageQueue.enqueue(sessionKey, incoming, (event) =>
        this.broadcast(event),
      );

      // If job has a delivery channel, send the result
      if (job.deliveryMode === "announce" && job.platform && job.channelId) {
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
          contentPreview: result.content.slice(0, 500),
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
      console.error(`[cron-engine] Job ${job.id} failed:`, errMsg);

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
