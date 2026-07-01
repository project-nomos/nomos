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
import { isLoopUserDisabled } from "../cron/loop-overrides.ts";

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
    // Per-user (per-customer DB) loop opt-out. The consumer Loops UI toggles a
    // config override rather than mutating the shared `system` row, so honor it
    // here: a managed loop the user turned off must actually stop firing. Absent
    // flag = enabled (default on). Keyed generically by job name so any future
    // override is covered without special-casing.
    if (await isLoopUserDisabled(job.name)) {
      log.info(`Skipping ${job.name}: disabled by user`);
      return;
    }

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

    // Intercept wiki-lint sentinel -- health-check each owner's wiki (orphans,
    // dangling links, superseded facts) and write the _lint.md report. Per owner,
    // off/cooldown-gated inside lintWiki.
    if (job.prompt === "__wiki_lint__") {
      log.info("Firing wiki lint");
      (async () => {
        const { lintWiki } = await import("../memory/wiki-lint.ts");
        const { listMemoryOwners } = await import("../auth/org-members.ts");
        for (const userId of await listMemoryOwners()) {
          try {
            const r = await lintWiki({ userId });
            if (r.wrote) {
              log.info(
                { userId, orphans: r.orphans, dangling: r.dangling, superseded: r.superseded },
                "Wiki lint report written",
              );
            }
          } catch (err) {
            log.warn(
              { err: err instanceof Error ? err.message : err, userId },
              "Wiki lint failed for owner",
            );
          }
        }
      })().catch((err) => {
        log.error({ err: err instanceof Error ? err.message : err }, "Wiki lint failed");
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

    // Intercept studio-gc sentinel -- clean up Studio objects/rows per owner
    // (unconfirmed uploads + aged intermediate edit results). DB is the clock.
    if (job.prompt === "__studio_gc__") {
      log.info("Firing studio GC");
      (async () => {
        const { runStudioGc } = await import("../studio/gc.ts");
        const r = await runStudioGc();
        log.info(r, "Studio GC complete");
      })().catch((err) => {
        log.error({ err: err instanceof Error ? err.message : err }, "Studio GC failed");
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

    // Intercept commitment-reminders sentinel -- check due commitments per owner
    // and deliver each owner's reminders to THAT owner's notification channel
    // (per-owner with global fallback; no agent turn).
    if (job.prompt === "__commitment_reminders__") {
      log.info("Firing commitment reminders");
      (async () => {
        const { runCommitmentReminders } = await import("../proactive/scheduler.ts");
        const results = await runCommitmentReminders();
        if (results.length === 0) return;
        const { getNotificationDefaultFor } = await import("../db/notification-defaults.ts");
        for (const r of results) {
          const nd = await getNotificationDefaultFor(r.userId);
          if (!nd) {
            log.warn({ userId: r.userId }, "No notification channel; skipping commitment reminder");
            continue;
          }
          await this.channelManager.send({
            inReplyTo: "commitment-reminder",
            platform: nd.platform,
            channelId: nd.channelId,
            content: r.text,
          });
        }
      })().catch((err) => {
        log.error({ err: err instanceof Error ? err.message : err }, "Commitment reminders failed");
      });
      return;
    }

    // Intercept triage-digest sentinel -- run the daily inbox triage per owner and
    // deliver each to that owner's channel (suppressed on a quiet day; no agent turn).
    if (job.prompt === "__triage_digest__") {
      log.info("Firing triage digest");
      (async () => {
        const { runTriageDigest } = await import("../proactive/scheduler.ts");
        const results = await runTriageDigest();
        if (results.length === 0) return;
        const { getNotificationDefaultFor } = await import("../db/notification-defaults.ts");
        for (const r of results) {
          const nd = await getNotificationDefaultFor(r.userId);
          if (!nd) continue;
          await this.channelManager.send({
            inReplyTo: "triage-digest",
            platform: nd.platform,
            channelId: nd.channelId,
            content: r.text,
          });
        }
      })().catch((err) => {
        log.error({ err: err instanceof Error ? err.message : err }, "Triage digest failed");
      });
      return;
    }

    // Intercept style-analyze sentinel -- re-derive each owner's writing voice
    // from sent messages. Self-gates on config.styleMatching (no-op when off).
    if (job.prompt === "__style_analyze__") {
      (async () => {
        const { loadEnvConfig } = await import("../config/env.ts");
        if (!loadEnvConfig().styleMatching) return;
        log.info("Firing style analysis");
        const { analyzeStyle } = await import("../memory/style-model.ts");
        const { listMemoryOwners } = await import("../auth/org-members.ts");
        for (const userId of await listMemoryOwners()) {
          try {
            const r = await analyzeStyle(userId);
            log.info({ userId, contactProfiles: r.contactProfiles }, "Style analysis complete");
          } catch (err) {
            log.warn(
              { err: err instanceof Error ? err.message : err, userId },
              "Style analysis failed for owner",
            );
          }
        }
      })().catch((err) => {
        log.error({ err: err instanceof Error ? err.message : err }, "Style analysis failed");
      });
      return;
    }

    // Intercept relationship-narrative sentinel -- the agent-authored "how we've come to
    // work together" reflection from the learned user_model, per owner. Self-gates on
    // adaptive memory (no-op when off, or when too little is learned yet).
    if (job.prompt === "__relationship_narrative__") {
      (async () => {
        const { loadEnvConfig } = await import("../config/env.ts");
        if (!loadEnvConfig().adaptiveMemory) return;
        log.info("Firing relationship narrative");
        const { writeRelationshipNarrative } = await import("../memory/relationship-narrative.ts");
        const { listMemoryOwners } = await import("../auth/org-members.ts");
        for (const userId of await listMemoryOwners()) {
          try {
            const r = await writeRelationshipNarrative(userId);
            if (r.wrote) log.info({ userId }, "Relationship narrative written");
          } catch (err) {
            log.warn(
              { err: err instanceof Error ? err.message : err, userId },
              "Relationship narrative failed for owner",
            );
          }
        }
      })().catch((err) => {
        log.error(
          { err: err instanceof Error ? err.message : err },
          "Relationship narrative failed",
        );
      });
      return;
    }

    // Intercept graph-semantic sentinel -- the full graph self-population pass,
    // per owner: (1) backfillGraph promotes vault notes / wiki articles / contacts
    // into kg_nodes (+ summaries) and frontmatter link edges, (2) embedMissingNodes
    // embeds the new nodes, (3) materializeSemanticEdges adds meaning-based edges.
    // Without this, the graph only filled via the manual `nomos brain` CLIs. No-op
    // embeddings without a provider (embedMissingNodes returns {embedded:0}).
    if (job.prompt === "__graph_semantic__") {
      log.info("Firing graph backfill + semantics");
      (async () => {
        const { backfillGraph } = await import("../memory/graph.ts");
        const { embedMissingNodes, materializeSemanticEdges } =
          await import("../memory/graph-semantic.ts");
        const { listMemoryOwners } = await import("../auth/org-members.ts");
        const orgId = process.env.NOMOS_ORG_ID ?? "local";
        for (const userId of await listMemoryOwners()) {
          try {
            const b = await backfillGraph({ orgId, userId });
            const e = await embedMissingNodes({ orgId, userId });
            const s = await materializeSemanticEdges({ orgId, userId });
            log.info(
              {
                userId,
                nodes: b.vaultNodes + b.wikiNodes + b.personNodes,
                embedded: e.embedded,
                edges: s.edges,
              },
              "Graph backfill + semantics complete",
            );
          } catch (err) {
            log.warn(
              { err: err instanceof Error ? err.message : err, userId },
              "Graph semantics failed for owner",
            );
          }
        }
      })().catch((err) => {
        log.error({ err: err instanceof Error ? err.message : err }, "Graph semantics failed");
      });
      return;
    }

    // Intercept background-watch sentinel -- poll registered background tasks
    // (CI, deploys, long bash) and, on completion, RESUME the original session
    // with the result so the agent picks the thread back up. The wait-and-resume
    // bridge: each settle enqueues a synthetic turn keyed to the task's own
    // sessionKey (not isolated), then delivers the follow-up to its channel.
    if (job.prompt === "__background_watch__") {
      (async () => {
        const { runBackgroundWatchSweep, buildResumePrompt } =
          await import("./background-tasks.ts");
        const { withLease } = await import("../storage/leases.ts");
        // In hosted (Redis) only one pod sweeps; withLease runs fn directly when
        // Redis is unconfigured (power-user), so this is correct in both modes.
        await withLease("background-watch", () =>
          runBackgroundWatchSweep(async (task) => {
            const incoming = {
              id: randomUUID(),
              platform: task.platform,
              channelId: task.channelId,
              userId: task.userId,
              content: buildResumePrompt(task),
              timestamp: new Date(),
              metadata: { source: "background-resume", backgroundTaskId: task.id },
            };
            const result = await this.messageQueue.enqueue(task.sessionKey, incoming, (event) =>
              this.broadcast(event),
            );
            const stripped = stripHeartbeatToken(result.content);
            if (stripped !== null && !result.content.trimStart().startsWith("[NOACTION]")) {
              await this.channelManager.send(result);
            }
          }),
        );
      })().catch((err) => {
        log.error({ err: err instanceof Error ? err.message : err }, "Background watch failed");
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
