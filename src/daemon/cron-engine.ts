/**
 * Wires the existing CronScheduler into the daemon message queue.
 *
 * When a cron job fires, it creates an IncomingMessage and enqueues it
 * for processing by the AgentRuntime.
 */

import { randomUUID } from "node:crypto";
import { getDb } from "../db/client.ts";
import { createCronSystem, type CronSystem, type CronJob } from "../cron/index.ts";
import type { MessageQueue } from "./message-queue.ts";
import type { ChannelManager } from "./channel-manager.ts";

export class CronEngine {
  private cronSystem: CronSystem | null = null;
  private messageQueue: MessageQueue;
  private channelManager: ChannelManager;

  constructor(messageQueue: MessageQueue, channelManager: ChannelManager) {
    this.messageQueue = messageQueue;
    this.channelManager = channelManager;
  }

  /** Initialize and start the cron system. */
  async start(): Promise<void> {
    const db = getDb();

    this.cronSystem = createCronSystem(db, async (job: CronJob) => {
      await this.handleCronJob(job);
    });

    // Load jobs from DB
    await this.cronSystem.refresh();
    this.cronSystem.start();

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

    const noop = () => {};

    try {
      const result = await this.messageQueue.enqueue(sessionKey, incoming, noop);

      // If job has a delivery channel, send the result
      if (job.deliveryMode === "announce" && job.platform && job.channelId) {
        await this.channelManager.send(result);
      }

      // Mark success
      if (this.cronSystem) {
        await this.cronSystem.store.markRun(job.id, true);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[cron-engine] Job ${job.id} failed:`, errMsg);

      if (this.cronSystem) {
        await this.cronSystem.store.markRun(job.id, false, errMsg);
        await this.cronSystem.store.disableOnErrors(job.id, 3);
      }
    }
  }
}
