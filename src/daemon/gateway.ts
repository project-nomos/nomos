/**
 * Gateway: main daemon orchestrator.
 *
 * Boots all subsystems in order, wires them together, and handles
 * graceful shutdown.
 */

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { systemTenant } from "../auth/tenant-context.ts";
import { fileURLToPath } from "node:url";
import { AgentRuntime } from "./agent-runtime.ts";
import { MessageQueue } from "./message-queue.ts";
import { DaemonWebSocketServer } from "./websocket-server.ts";
import { GrpcServer } from "./grpc-server.ts";
import { ConnectServer } from "./connect-server.ts";
import { ChannelManager } from "./channel-manager.ts";
import { CronEngine } from "./cron-engine.ts";
import { DraftManager } from "./draft-manager.ts";
import { ElicitationManager } from "./elicitation-manager.ts";
import { writePidFile, installSignalHandlers } from "./lifecycle.ts";
import { SlackAdapter } from "./channels/slack.ts";
import { SlackUserAdapter } from "./channels/slack-user.ts";
import { SlackPollingAdapter } from "./channels/slack-polling.ts";
import { DiscordAdapter } from "./channels/discord.ts";
import { TelegramAdapter } from "./channels/telegram.ts";
import { WhatsAppAdapter } from "./channels/whatsapp.ts";
import { IMessageAdapter } from "./channels/imessage.ts";
import { StreamingResponder } from "./streaming-responder.ts";
import { MessageBatcher } from "./message-batcher.ts";
import { indexConversationTurn } from "./memory-indexer.ts";
import { closeBrowser } from "../sdk/browser.ts";
import { sendProactiveMessage } from "./proactive-sender.ts";
import { registerDeltaSyncJobs } from "../ingest/delta-sync.ts";
import { IngestScheduler } from "../ingest/scheduler.ts";
import { EmailAdapter } from "./channels/email.ts";
import { observeMessage } from "./observer.ts";
import { registerProactiveJobs } from "../proactive/scheduler.ts";
import { FEATURES } from "../config/mode.ts";
import {
  initCATEIntegration,
  stopCATEIntegration,
  type CATEIntegration,
} from "../cate/integration.ts";
import type { IncomingMessage, AgentEvent } from "./types.ts";
import type { DraftRow } from "../db/drafts.ts";
import { createLogger } from "../lib/logger.ts";

const log = createLogger("gateway");

export interface GatewayOptions {
  /** WebSocket server port (default: 8765) */
  port?: number;
  /** gRPC server port (default: port + 1, i.e., 8766) */
  grpcPort?: number;
  /** Connect (HTTP) server port for mobile clients (default: grpcPort + 1, i.e., 8767) */
  connectPort?: number;
  /** Skip channel adapters (useful for testing) */
  skipChannels?: boolean;
  /** Skip cron engine */
  skipCron?: boolean;
  /** Launch the Settings UI as a child process (default: false) */
  withSettings?: boolean;
  /** Settings UI port (default: 3456) */
  settingsPort?: number;
}

export class Gateway {
  private runtime: AgentRuntime;
  private messageQueue: MessageQueue;
  private wsServer: DaemonWebSocketServer;
  private grpcServer: GrpcServer;
  private connectServer: ConnectServer;
  private channelManager: ChannelManager;
  private cronEngine: CronEngine;
  private draftManager: DraftManager;
  private elicitationManager!: ElicitationManager;
  private settingsProcess: ChildProcess | null = null;
  private cateIntegration: CATEIntegration | null = null;
  private notifyListener: { unlisten: () => Promise<void> } | null = null;
  private ingestScheduler: IngestScheduler;
  // Removed: pendingSlackIngest -- bulk ingestion retired in favor of agent conversation learning
  private options: GatewayOptions;

  constructor(options: GatewayOptions = {}) {
    this.options = options;

    // 1. Create agent runtime
    this.runtime = new AgentRuntime();

    // 2. Create message queue wired to the runtime
    this.messageQueue = new MessageQueue(
      (msg: IncomingMessage, emit: (event: AgentEvent) => void) =>
        this.runtime.processMessage(msg, emit),
    );

    // 3. Create draft manager (wired after servers are created)
    this.draftManager = new DraftManager({
      notifyWs: (event) => {
        this.wsServer.broadcast(event);
        this.grpcServer.broadcast(event);
      },
      notifyDefaultChannel: (draft, context) =>
        this.sendDraftNotificationToDefaultChannel(draft, context),
      notifyDefaultChannelFyi: (platform, channelId, content, context) =>
        this.sendFyiNotificationToDefaultChannel(platform, channelId, content, context),
    });

    // 4. Create WebSocket server
    this.wsServer = new DaemonWebSocketServer(
      this.messageQueue,
      options.port ?? 8765,
      this.draftManager,
    );

    // 4b. Create gRPC server
    this.grpcServer = new GrpcServer(
      this.messageQueue,
      options.grpcPort ?? (options.port ?? 8765) + 1,
      this.draftManager,
    );

    // 4c. Create Connect server (HTTP/1.1 — mobile clients use this).
    const grpcPort = options.grpcPort ?? (options.port ?? 8765) + 1;
    this.connectServer = new ConnectServer({
      messageQueue: this.messageQueue,
      draftManager: this.draftManager,
      port: options.connectPort ?? grpcPort + 1,
    });

    // 5. Create channel manager
    this.channelManager = new ChannelManager();

    // 5b. Elicitation manager — handles `ask_user` (and any other MCP
    // elicitation) by rendering questions on the active channel and
    // resolving when the user clicks/replies. Hand it to the runtime so
    // its `onElicitation` callback can dispatch through here.
    this.elicitationManager = new ElicitationManager(this.channelManager);
    this.runtime.setElicitationManager(this.elicitationManager);
    this.grpcServer.setElicitationManager(this.elicitationManager);

    // 6. Create cron engine with broadcast to connected clients
    this.cronEngine = new CronEngine(this.messageQueue, this.channelManager, (event) => {
      this.wsServer.broadcast(event);
      this.grpcServer.broadcast(event);
    });

    // 7. Create ingest scheduler (subprocess spawning wired later in start())
    this.ingestScheduler = new IngestScheduler((subcommand, extraArgs, label) =>
      this.runIngestSubprocess(subcommand, label, extraArgs),
    );
  }

  /** Start the daemon. */
  async start(): Promise<void> {
    log.info("Starting daemon...");

    // Write PID file
    writePidFile();

    // Install signal handlers for graceful shutdown
    installSignalHandlers(() => this.stop());

    // Start the Settings UI as early as possible so the setup wizard is
    // reachable even if the rest of the boot fails (e.g. the DB doesn't
    // exist yet on a fresh install). The wizard creates the DB and writes
    // env vars; the next daemon restart picks them up and finishes booting.
    if (this.options.withSettings) {
      try {
        await this.startSettingsServer();
      } catch (err) {
        log.warn(
          { err: err instanceof Error ? err.message : err },
          "Settings UI failed to start early",
        );
      }
    }

    // Initialize agent runtime (loads config, runs migrations). If the DB
    // is unreachable (e.g. database does not exist yet), log a warning but
    // keep the daemon alive — the Settings UI we just started gives the
    // user a place to configure it.
    let runtimeReady = true;
    try {
      await this.runtime.initialize();
    } catch (err) {
      runtimeReady = false;
      log.warn(
        { err: err instanceof Error ? err.message : err },
        "Agent runtime failed to initialize",
      );
      log.warn(
        "Daemon is running in setup-only mode. Finish setup at http://localhost:" +
          (this.options.settingsPort ?? 3456),
      );
    }

    // If the runtime didn't come up, skip the rest of the boot. We keep
    // the Settings UI + signal handlers alive so the user can configure
    // and the daemon restart picks it up.
    if (!runtimeReady) {
      log.info("Daemon is running (setup-only)");
      return;
    }

    // Sync config files (SOUL.md, TOOLS.md, IDENTITY.md, skills) disk <-> DB
    try {
      const { syncAllFiles } = await import("../config/file-sync.ts");
      await syncAllFiles();
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : err }, "File sync failed");
    }

    // Load the event-driven hook registry (~/.nomos/hooks.json + ./.nomos/hooks.json)
    // into the process-global singleton so PreToolUse blocking is reachable. No-op
    // for users without a hooks.json. cwd-tier hooks depend on the daemon's cwd.
    try {
      const { initializeHooks } = await import("../hooks/registry.ts");
      const reg = await initializeHooks();
      const count = reg.getAllHooks().length;
      if (count > 0) log.info(`Loaded ${count} hook(s) from hooks.json`);
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : err }, "Hook registry load failed");
    }

    // Verify LLM access before starting services
    await this.checkLlmAccess();

    // Seed autonomous loops (idempotent — safe to call on every start)
    try {
      const { seedAutonomousLoops } = await import("./autonomous.ts");
      await seedAutonomousLoops();
    } catch (err) {
      log.warn({ err }, "Failed to seed autonomous loops");
    }

    // Start WebSocket server
    await this.wsServer.start();

    // Start gRPC server
    await this.grpcServer.start();

    // Start Connect server (mobile clients) — same handlers, HTTP-friendly wire.
    try {
      await this.connectServer.start();
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : err },
        "Connect server failed to start (mobile clients will be unable to reach the daemon)",
      );
    }

    // Register command handler for hot-reload and ingestion triggers
    this.grpcServer.onCommand((command) => this.handleCommand(command));

    // Subscribe to Postgres LISTEN/NOTIFY so the Settings UI can trigger
    // the same handlers without a separate IPC channel. The Settings UI
    // issues NOTIFY nomos_reload, '<payload>' (see settings/src/lib/notify-daemon.ts).
    try {
      const { getDb } = await import("../db/client.ts");
      const sql = getDb();
      // `sql.listen` uses its own connection internally; we keep the handle
      // so we can unlisten on shutdown.
      const listener = await sql.listen("nomos_reload", (payload) => {
        if (!payload) return;
        // Map the "reload-slack-workspaces" UI payload to the canonical command
        const cmd = payload === "slack-workspaces" ? "reload-slack-workspaces" : payload;
        this.handleCommand(cmd).catch((err) => {
          log.warn({ payload, err }, "NOTIFY handler failed");
        });
      });
      this.notifyListener = listener;
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : err },
        "Could not start NOTIFY listener (settings reloads will be best-effort)",
      );
    }

    // Register and start channel adapters
    if (!this.options.skipChannels) {
      await this.registerChannelAdapters();
      await this.channelManager.start();

      // Note: Slack/Discord/Telegram bulk ingestion removed.
      // Agent learns from direct conversations and draft edits, not raw message history.
      // Manual ingestion still available via CLI: nomos ingest slack --since DATE
    }

    // Auto-ingest Gmail when Google Workspace is configured
    try {
      const { isGoogleWorkspaceConfiguredAsync } = await import("../sdk/google-workspace-mcp.ts");
      if (await isGoogleWorkspaceConfiguredAsync()) {
        this.ingestScheduler.triggerStartup("gmail", "history", "gmail");
      }
    } catch {
      // Google Workspace not available
    }

    // Start cron engine
    if (!this.options.skipCron) {
      try {
        await this.cronEngine.start();
      } catch (err) {
        log.warn({ err }, "Cron engine failed to start");
      }
    }

    // Register delta sync cron jobs for ingestion
    try {
      await registerDeltaSyncJobs();
    } catch (err) {
      log.warn({ err }, "Delta sync registration failed");
    }

    // Register proactive feature cron jobs
    try {
      await registerProactiveJobs();
    } catch (err) {
      log.warn({ err }, "Proactive jobs registration failed");
    }

    // Register / reconcile the wiki compilation cron job. Cadence comes from
    // app.wikiCompileInterval (the same value drives the compiler's cooldown);
    // fall back to "1h" if unset or not a valid duration. The compiler self-gates
    // on app.wikiEnabled at fire time, so the job stays registered and honours
    // runtime enable/disable toggles. We reconcile an existing job's schedule on
    // boot (mirrors registerDeltaSyncJobs) so a changed interval takes effect on
    // restart -- the cooldown picks it up live, the cron cadence on the next boot.
    try {
      const { CronStore } = await import("../cron/store.ts");
      const { loadEnvConfigAsync } = await import("../config/env.ts");
      const { parseInterval } = await import("../cron/scheduler.ts");
      const cronStore = new CronStore();

      const cfg = await loadEnvConfigAsync();
      let schedule = cfg.wikiCompileInterval ?? "1h";
      try {
        parseInterval(schedule);
      } catch {
        schedule = "1h"; // invalid duration string -> safe default
      }

      const existingWikiJob = await cronStore.getJobByName("wiki-compile");
      if (!existingWikiJob) {
        await cronStore.createJob({
          userId: systemTenant().userId,
          name: "wiki-compile",
          schedule,
          scheduleType: "every",
          sessionTarget: "isolated",
          deliveryMode: "none",
          prompt: "__wiki_compile__",
          enabled: true,
          errorCount: 0,
        });
        log.info({ schedule }, "Registered wiki compilation cron job");
        process.emit("cron:refresh" as never);
      } else if (existingWikiJob.schedule !== schedule) {
        await cronStore.updateJob(existingWikiJob.id, { schedule });
        log.info(
          { from: existingWikiJob.schedule, to: schedule },
          "Reconciled wiki compilation cron cadence",
        );
        process.emit("cron:refresh" as never);
      }
    } catch (err) {
      log.warn({ err }, "Wiki cron registration failed");
    }

    // Register auto-dream + magic-docs background jobs. Both are sentinel
    // prompts handled directly by CronEngine.handleCronJob (no agent turn).
    try {
      const { CronStore } = await import("../cron/store.ts");
      const cronStore = new CronStore();

      // Auto-dream consolidation: fire every 6h; the runner is singleton-gated
      // (1h + >=10 new chunks) and leased, so it no-ops when not yet due.
      if (!(await cronStore.getJobByName("auto-dream"))) {
        await cronStore.createJob({
          userId: systemTenant().userId,
          name: "auto-dream",
          schedule: "6h",
          scheduleType: "every",
          sessionTarget: "isolated",
          deliveryMode: "none",
          prompt: "__auto_dream__",
          enabled: true,
          errorCount: 0,
        });
        log.info("Registered auto-dream cron job (every 6h)");
        process.emit("cron:refresh" as never);
      }

      // Background-task watcher: poll registered background tasks (CI/deploy/long
      // bash) every 1m and resume the original session when one settles. No-op
      // when nothing is registered. Sentinel handled in CronEngine.handleCronJob.
      if (!(await cronStore.getJobByName("background-watch"))) {
        await cronStore.createJob({
          userId: systemTenant().userId,
          name: "background-watch",
          schedule: "1m",
          scheduleType: "every",
          sessionTarget: "isolated",
          deliveryMode: "none",
          prompt: "__background_watch__",
          enabled: true,
          errorCount: 0,
        });
        log.info("Registered background-watch cron job (every 1m)");
        process.emit("cron:refresh" as never);
      }

      // Magic-docs refresh: re-sync self-updating docs every 1h (content-gated).
      if (!(await cronStore.getJobByName("magic-docs-refresh"))) {
        await cronStore.createJob({
          userId: systemTenant().userId,
          name: "magic-docs-refresh",
          schedule: "1h",
          scheduleType: "every",
          sessionTarget: "isolated",
          deliveryMode: "none",
          prompt: "__magic_docs__",
          enabled: true,
          errorCount: 0,
        });
        log.info("Registered magic-docs refresh cron job (every 1h)");
        process.emit("cron:refresh" as never);
      }

      // Studio GC: clean up Studio objects/rows daily (hosted-only feature, so
      // seed only when Studio is enabled; the runner is a no-op without rows).
      if (FEATURES.studio() && !(await cronStore.getJobByName("studio-gc"))) {
        await cronStore.createJob({
          userId: systemTenant().userId,
          name: "studio-gc",
          schedule: "24h",
          scheduleType: "every",
          sessionTarget: "isolated",
          deliveryMode: "none",
          prompt: "__studio_gc__",
          enabled: true,
          errorCount: 0,
        });
        log.info("Registered studio GC cron job (every 24h)");
        process.emit("cron:refresh" as never);
      }

      // Studio: install the optional server-side face embedder for the identity
      // gate when a model is configured (NOMOS_FACE_MODEL_PATH). No-op otherwise;
      // the privacy-preferred path is the on-device check via StudioReportIdentity.
      if (FEATURES.studio()) {
        try {
          const { installServerFaceEmbedder } = await import("../studio/face-embedder.ts");
          await installServerFaceEmbedder();
        } catch (err) {
          log.warn({ err }, "studio: face embedder install skipped");
        }
        // Best-effort: bring up the deterministic beauty-ops sidecar (external URL
        // or `uv run` from the sibling clone). Non-fatal — retouch falls back to
        // the cloud provider when it's absent.
        try {
          const { ensureStudioSidecar } = await import("../studio/sidecar-launcher.ts");
          await ensureStudioSidecar();
        } catch (err) {
          log.warn({ err }, "studio: sidecar launch skipped");
        }
      }

      // Style analysis: re-derive the user's writing voice daily. Self-gates on
      // config.styleMatching at fire time, so the job is harmless when the
      // feature is off (and reflects a later toggle without reseeding).
      if (!(await cronStore.getJobByName("style-analyze"))) {
        await cronStore.createJob({
          userId: systemTenant().userId,
          name: "style-analyze",
          schedule: "24h",
          scheduleType: "every",
          sessionTarget: "isolated",
          deliveryMode: "none",
          prompt: "__style_analyze__",
          enabled: true,
          errorCount: 0,
        });
        log.info("Registered style-analyze cron job (every 24h)");
        process.emit("cron:refresh" as never);
      }

      // Graph semantics: embed kg_nodes that lack an embedding and materialize
      // meaning-based (semantic_sibling) edges, every 6h. Otherwise the kg_nodes
      // vector index + semantic traversal stay dormant (only the manual
      // `nomos brain semantic` CLI populated them).
      if (!(await cronStore.getJobByName("graph-semantic"))) {
        await cronStore.createJob({
          userId: systemTenant().userId,
          name: "graph-semantic",
          schedule: "6h",
          scheduleType: "every",
          sessionTarget: "isolated",
          deliveryMode: "none",
          prompt: "__graph_semantic__",
          enabled: true,
          errorCount: 0,
        });
        log.info("Registered graph-semantic cron job (every 6h)");
        process.emit("cron:refresh" as never);
      }

      // Relationship narrative: weekly, the agent writes "how we've come to work
      // together" from the learned user_model into relationship.md. Otherwise the agent
      // deepens its understanding but never articulates it (understanding != narrative).
      if (!(await cronStore.getJobByName("relationship-narrative"))) {
        await cronStore.createJob({
          userId: systemTenant().userId,
          name: "relationship-narrative",
          schedule: "168h",
          scheduleType: "every",
          sessionTarget: "isolated",
          deliveryMode: "none",
          prompt: "__relationship_narrative__",
          enabled: true,
          errorCount: 0,
        });
        log.info("Registered relationship-narrative cron job (every 168h)");
        process.emit("cron:refresh" as never);
      }
    } catch (err) {
      log.warn({ err }, "Auto-dream/magic-docs cron registration failed");
    }

    // Reconcile the on-disk wiki cache with the DB at boot, power-user only
    // (hosted pods share the DB; a per-node disk copy would diverge). Empty DB
    // hydrates from disk; otherwise the DB is mirrored to disk. Fire-and-forget
    // so a large disk walk never blocks the rest of boot.
    try {
      const { isHosted } = await import("../config/mode.ts");
      if (!isHosted()) {
        const { reconcileOnStartup } = await import("../memory/wiki-sync.ts");
        const { listMemoryOwners } = await import("../auth/org-members.ts");
        void (async () => {
          for (const userId of await listMemoryOwners()) {
            await reconcileOnStartup(userId).catch((err) =>
              log.warn(
                { err: err instanceof Error ? err.message : err, userId },
                "Wiki reconcile failed for owner",
              ),
            );
          }
        })();
      }
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : err }, "Wiki reconcile skipped");
    }

    // Start CATE protocol server (agent-to-agent trust layer)
    try {
      this.cateIntegration = await initCATEIntegration({
        port: 8801,
        onMessage: async (envelope) => {
          // Route incoming CATE envelopes to the message queue
          const payload = envelope.payload ?? "";
          const msg: IncomingMessage = {
            id: envelope.header.msg_id,
            platform: "cate",
            channelId: envelope.header.thread_id,
            threadId: envelope.header.thread_id,
            // The vault/memory owner is the LOCAL recipient, not the remote
            // sender. The sender DID is surfaced separately (broadcast below) for
            // trust/display; using it as the owner would spin up a junk per-DID
            // partition.
            userId: systemTenant().userId,
            content: payload,
            timestamp: new Date(envelope.header.timestamp),
          };
          const sessionKey = `cate:${envelope.header.thread_id}`;
          this.broadcast({
            type: "system",
            subtype: "message_received",
            message: `Agent-to-agent message from ${envelope.parties.from.did}`,
            data: {
              platform: "cate",
              channelId: envelope.header.thread_id,
              userId: envelope.parties.from.did,
              preview: payload.slice(0, 120),
              timestamp: envelope.header.timestamp,
            },
          });
          this.messageQueue.enqueue(sessionKey, msg, () => {});
        },
      });
    } catch (err) {
      log.warn({ err }, "CATE integration failed to start");
    }

    // Listen for ingest trigger events (from cron engine delta-sync)
    process.on(
      "ingest:trigger" as never,
      ((event: { platform: string; runType: "full" | "delta" }) => {
        const sub = IngestScheduler.platformToSubcommand(event.platform);
        if (!sub) return;
        if (event.runType === "delta") {
          this.ingestScheduler.triggerDelta(event.platform, "history", sub);
        } else {
          this.ingestScheduler.triggerFull(event.platform, "history", sub);
        }
      }) as never,
    );

    // Listen for proactive send events from agent tools
    process.on(
      "proactive:send" as never,
      ((event: {
        platform: string;
        channelId: string;
        content: string;
        callback: (result: boolean) => void;
      }) => {
        sendProactiveMessage(this.channelManager, {
          platform: event.platform,
          channelId: event.channelId,
          content: event.content,
        })
          .then((delivered: boolean) => event.callback(delivered))
          .catch(() => event.callback(false));
      }) as never,
    );

    // Start Settings UI as a child process
    if (this.options.withSettings) {
      await this.startSettingsServer();
    }

    const platforms = this.channelManager.listPlatforms();
    const wsPort = this.options.port ?? 8765;
    const grpcPort = this.options.grpcPort ?? wsPort + 1;
    const settingsPort = this.options.settingsPort ?? 3456;
    log.info("Daemon is running");
    log.info(`  gRPC:      localhost:${grpcPort}`);
    log.info(`  WebSocket: ws://localhost:${wsPort}`);
    if (this.settingsProcess) {
      log.info(`  Settings:  http://localhost:${settingsPort}`);
    }
    log.info(`  Channels: ${platforms.length > 0 ? platforms.join(", ") : "none"}`);
  }

  /** Stop the daemon gracefully. */
  async stop(): Promise<void> {
    log.info("Stopping daemon...");

    // Stop in reverse order
    if (this.notifyListener) {
      await this.notifyListener.unlisten().catch(() => {});
      this.notifyListener = null;
    }
    if (this.cateIntegration) {
      await stopCATEIntegration(this.cateIntegration);
    }
    this.stopSettingsServer();
    this.cronEngine.stop();
    await this.channelManager.stop();
    await this.grpcServer.stop();
    await this.connectServer.stop();
    await this.wsServer.stop();
    if (FEATURES.studio()) {
      try {
        const { stopStudioSidecar } = await import("../studio/sidecar-launcher.ts");
        await stopStudioSidecar();
      } catch {
        // best-effort
      }
    }
    await closeBrowser();

    log.info("Daemon stopped");
  }

  /**
   * Dispatch a command from either gRPC `Command` RPC or a Postgres
   * NOTIFY on the `nomos_reload` channel. Routes to reload / ingest /
   * delta handlers.
   */
  async handleCommand(command: string): Promise<string> {
    if (command === "reload-slack-workspaces") {
      const added = await this.reloadSlackWorkspaces();
      return added.length > 0
        ? `Loaded ${added.length} workspace(s): ${added.join(", ")}`
        : "No new workspaces to load";
    }

    if (command.startsWith("trigger-ingest:")) {
      const platform = command.slice("trigger-ingest:".length);
      const sub = IngestScheduler.platformToSubcommand(platform);
      if (!sub) return `Unknown platform: ${platform}`;
      this.ingestScheduler.triggerFull(platform, "history", sub);
      return `Full ingestion triggered for ${platform}`;
    }

    if (command.startsWith("trigger-delta:")) {
      const platform = command.slice("trigger-delta:".length);
      const sub = IngestScheduler.platformToSubcommand(platform);
      if (!sub) return `Unknown platform: ${platform}`;
      this.ingestScheduler.triggerDelta(platform, "history", sub);
      return `Delta sync triggered for ${platform}`;
    }

    if (command === "reload-proactive") {
      await registerProactiveJobs();
      return "Proactive jobs reloaded";
    }

    if (command === "reload-cron") {
      // A loop was enabled/disabled/edited/deleted in the Settings UI (a separate
      // process). Make the in-process cron engine re-read the DB so the change is
      // live without a daemon restart.
      process.emit("cron:refresh" as never);
      return "Cron schedule reloaded";
    }

    return `Unknown command: ${command}`;
  }

  /**
   * Full sync of Slack workspace adapters against DB state.
   * Adds new workspaces, removes deleted ones, refreshes tokens for existing ones.
   */
  async reloadSlackWorkspaces(): Promise<string[]> {
    const { listWorkspaces, syncSlackConfigToFile } = await import("../db/slack-workspaces.ts");
    const workspaces = await listWorkspaces();
    const changes: string[] = [];

    // Sync config file for nomos-slack-mcp
    try {
      await syncSlackConfigToFile();
    } catch {
      // Non-critical
    }

    // Build set of expected platforms from DB
    const expectedPlatforms = new Set(workspaces.map((ws) => `slack-user:${ws.team_id}`));

    // Remove adapters for workspaces no longer in DB
    for (const platform of this.channelManager.listPlatforms()) {
      if (platform.startsWith("slack-user:") && !expectedPlatforms.has(platform)) {
        await this.channelManager.removeAdapter(platform);
        changes.push(`removed ${platform}`);
      }
    }

    const enqueue = (rawMsg: IncomingMessage) => {
      this.channelManager
        .transformIncoming(rawMsg)
        .then((msg) => {
          const sessionKey = `${msg.platform}:${msg.channelId}`;
          const adapter = this.channelManager.getAdapter(msg.platform);

          let responder: StreamingResponder | null = null;
          if (adapter?.postMessage && adapter?.updateMessage) {
            responder = new StreamingResponder(
              (text) => adapter.postMessage!(msg.channelId, text, msg.threadId),
              (ts, text) => adapter.updateMessage!(msg.channelId, ts, text),
              adapter.deleteMessage ? (ts) => adapter.deleteMessage!(msg.channelId, ts) : undefined,
            );
          }

          this.messageQueue
            .enqueue(sessionKey, msg, responder?.handleEvent ?? (() => {}))
            .then(async (result) => {
              if (responder) {
                const handled = await responder.finalize(result.content);
                if (!handled) await this.channelManager.send(result);
              } else {
                await this.channelManager.send(result);
              }
              indexConversationTurn(msg, result).catch((err) =>
                log.error({ err }, "Memory indexing failed"),
              );
            })
            .catch(async (err) => {
              await responder?.finalize("Sorry, an error occurred.");
              log.error({ err }, `Failed to process message from ${msg.platform}`);
            });
        })
        .catch((err) => {
          log.error({ err }, `Incoming hook transform failed`);
        });
    };

    // Add new or refresh all workspaces (registerAndStart replaces existing adapters)
    for (const ws of workspaces) {
      const platform = `slack-user:${ws.team_id}`;
      const existing = this.channelManager.hasAdapter(platform);

      const adapter = new SlackPollingAdapter({
        token: ws.access_token,
        cookie: ws.cookie_d,
        teamId: ws.team_id,
        onMessage: enqueue,
        draftManager: this.draftManager,
        onAuthError: (teamId, teamName, info) => {
          const event = {
            type: "system" as const,
            subtype: "auth_error",
            message:
              info?.reason ??
              `Slack session expired for ${teamName} (${teamId}) — run \`nomos slack auth\` to reconnect`,
            data: {
              platform: `slack-user:${teamId}`,
              teamId,
              teamName,
              kind: info?.kind ?? "user",
            },
          };
          this.wsServer.broadcast(event);
          this.grpcServer.broadcast(event);
        },
      });
      await this.channelManager.registerAndStart(adapter);
      this.draftManager.registerSendFn(adapter.platform, (channelId, text, threadId) =>
        adapter.sendAsUser(channelId, text, threadId),
      );

      // Auto-ingest on first add (skips if already completed)
      if (!existing) {
        this.ingestScheduler.triggerAuto(`slack:${ws.team_id}`, "history", "slack");
      }

      changes.push(`${existing ? "refreshed" : "added"} ${ws.team_name} (${ws.team_id})`);
    }

    // Refresh agent runtime's workspace MCP servers
    try {
      await this.runtime.reloadSlackWorkspaceMcps();
    } catch (err) {
      log.error({ err }, "Failed to reload workspace MCP servers");
    }

    // Auto-set default notification channel if none exists
    try {
      const { getNotificationDefault, setNotificationDefault } =
        await import("../db/notification-defaults.ts");
      const existing = await getNotificationDefault();
      if (!existing && workspaces.length > 0) {
        const ws = workspaces[0];
        await setNotificationDefault({
          platform: `slack-user:${ws.team_id}`,
          channelId: ws.user_id,
          label: `DM in ${ws.team_name}`,
        });
        log.info(`Auto-set notification default: DM in ${ws.team_name}`);
      }
    } catch {
      // Non-critical
    }

    if (changes.length > 0) {
      log.info(`Slack workspace sync: ${changes.join(", ")}`);
    }

    return changes;
  }

  /** Find the settings/ directory relative to the running script. */
  private findSettingsDir(): string | null {
    const __filename = fileURLToPath(import.meta.url);
    let dir = path.dirname(__filename);
    for (let i = 0; i < 5; i++) {
      const candidate = path.join(dir, "settings");
      if (fs.existsSync(path.join(candidate, "package.json"))) {
        return candidate;
      }
      dir = path.dirname(dir);
    }
    return null;
  }

  /** Start the Settings UI (Next.js) as a managed child process. */
  private async startSettingsServer(): Promise<void> {
    // Idempotent — start() may call this twice (early, then again after runtime init).
    if (this.settingsProcess) return;

    const settingsDir = this.findSettingsDir();
    if (!settingsDir) {
      log.warn("Settings directory not found — skipping Settings UI");
      return;
    }

    const port = String(this.options.settingsPort ?? 3456);

    // Check if .next build exists
    const buildId = path.join(settingsDir, ".next", "BUILD_ID");
    if (!fs.existsSync(buildId)) {
      log.warn("Settings UI not built — run `cd settings && pnpm build`");
      return;
    }

    // Prefer standalone server (output: "standalone" in next.config),
    // fall back to `next start` if standalone not available
    // Standalone server may be at .next/standalone/server.js or .next/standalone/<dirname>/server.js
    const settingsDirName = path.basename(settingsDir);
    const standaloneCandidates = [
      path.join(settingsDir, ".next", "standalone", settingsDirName, "server.js"),
      path.join(settingsDir, ".next", "standalone", "server.js"),
    ];
    const standaloneServer = standaloneCandidates.find((p) => fs.existsSync(p));
    let child: import("node:child_process").ChildProcess;

    if (standaloneServer) {
      child = spawn(process.execPath, [standaloneServer], {
        cwd: settingsDir,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PORT: port, HOSTNAME: "0.0.0.0", NOMOS_PARENT_DAEMON: "1" },
      });
    } else {
      // Fallback: find the next binary
      const nextBinCandidates = [
        path.join(settingsDir, "node_modules", ".bin", "next"),
        path.join(settingsDir, "..", "node_modules", ".bin", "next"),
      ];
      const nextBin = nextBinCandidates.find((p) => fs.existsSync(p));
      if (!nextBin) {
        log.warn("Next.js binary not found — skipping Settings UI");
        return;
      }
      child = spawn(nextBin, ["start", "--port", port], {
        cwd: settingsDir,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PORT: port, NOMOS_PARENT_DAEMON: "1" },
      });
    }

    child.stdout?.on("data", (data: Buffer) => {
      const line = data.toString().trim();
      if (line) log.info(`[settings] ${line}`);
    });

    child.stderr?.on("data", (data: Buffer) => {
      const line = data.toString().trim();
      if (line) log.error(`[settings] ${line}`);
    });

    child.on("exit", (code, signal) => {
      if (this.settingsProcess === child) {
        log.warn(`Settings UI exited (code=${code}, signal=${signal})`);
        this.settingsProcess = null;
      }
    });

    this.settingsProcess = child;
    log.info(`Settings UI starting on port ${port}`);
  }

  /** Stop the Settings UI child process. */
  private stopSettingsServer(): void {
    if (this.settingsProcess) {
      log.info("Stopping Settings UI...");
      this.settingsProcess.kill("SIGTERM");
      this.settingsProcess = null;
    }
  }

  /** Verify LLM API access works before starting services. */
  private async checkLlmAccess(): Promise<void> {
    log.info("Checking LLM access...");

    const apiKey = process.env.ANTHROPIC_API_KEY;
    const baseUrl = process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com";
    const useVertex = process.env.CLAUDE_CODE_USE_VERTEX === "1";

    if (useVertex) {
      log.info("Using Vertex AI — skipping API key check");
      return;
    }

    // Subscription mode uses the Claude Max/Pro OAuth credentials (macOS
    // keychain / ~/.claude), not an API key — so an absent ANTHROPIC_API_KEY
    // is expected and not a failure.
    if (process.env.NOMOS_USE_SUBSCRIPTION === "true") {
      log.info("Using Claude subscription (Max/Pro) — skipping API key check");
      return;
    }

    if (!apiKey) {
      log.warn(
        "⚠ No ANTHROPIC_API_KEY set — set one, enable NOMOS_USE_SUBSCRIPTION, or use Vertex",
      );
      return;
    }

    try {
      const res = await fetch(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: this.runtime.getModel(),
          max_tokens: 1,
          messages: [{ role: "user", content: "hi" }],
        }),
      });

      if (res.ok) {
        log.info("LLM access verified");
      } else {
        const body = await res.text();
        log.error(`LLM access check failed (${res.status}): ${body}`);
        log.error("Verify ANTHROPIC_API_KEY and model configuration in .env");
        log.warn("⚠ Daemon starting without verified LLM access");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err: message }, `LLM access check failed`);
      log.warn("⚠ Daemon starting without verified LLM access");
    }
  }

  /** Broadcast a system event to all connected clients (gRPC + WebSocket). */
  private broadcast(event: AgentEvent): void {
    this.wsServer.broadcast(event);
    this.grpcServer.broadcast(event);
  }

  /** Process a message through the agent runtime (message queue → agent → response). */
  private processAgentMessage(msg: IncomingMessage): void {
    const adapter = this.channelManager.getAdapter(msg.platform);
    const sessionKey = `${msg.platform}:${msg.channelId}`;

    // Create streaming responder if adapter supports progressive updates
    let responder: StreamingResponder | null = null;
    if (adapter?.postMessage && adapter?.updateMessage) {
      responder = new StreamingResponder(
        (text) => adapter.postMessage!(msg.channelId, text, msg.threadId),
        (ts, text) => adapter.updateMessage!(msg.channelId, ts, text),
        adapter.deleteMessage ? (ts) => adapter.deleteMessage!(msg.channelId, ts) : undefined,
      );
    }

    this.messageQueue
      .enqueue(sessionKey, msg, responder?.handleEvent ?? (() => {}))
      .then(async (result) => {
        if (responder) {
          const handled = await responder.finalize(result.content);
          if (!handled) {
            await this.channelManager.send(result);
          }
        } else {
          await this.channelManager.send(result);
        }

        // Fire-and-forget: index conversation turn into vector memory
        indexConversationTurn(msg, result).catch((err) =>
          log.error({ err }, "Memory indexing failed"),
        );
      })
      .catch(async (err) => {
        // Update placeholder with error if possible
        await responder?.finalize("Sorry, an error occurred.");
        log.error({ err }, `Failed to process message from ${msg.platform}`);
      });
  }

  /** Register available channel adapters based on env vars. */
  private async registerChannelAdapters(): Promise<void> {
    // Message batcher: debounces rapid sequential messages from the same sender.
    // Only non-default-channel messages are batched; default channel is instant.
    const batcher = new MessageBatcher({
      onReady: (msg) => this.processAgentMessage(msg),
    });

    const enqueue = (rawMsg: IncomingMessage) => {
      // Run incoming transform hooks (fire-and-forget the async, enqueue immediately)
      this.channelManager
        .transformIncoming(rawMsg)
        .then(async (msg) => {
          const adapter = this.channelManager.getAdapter(msg.platform);

          // If there's a pending ask_user elicitation on this channel and
          // the message text matches one of its options, consume the
          // message as an answer and skip agent processing. This is the
          // generic text-reply path; Slack buttons go through the action
          // handler in slack-user.ts and never reach here.
          const consumed = this.elicitationManager.tryConsumeTextReply(
            { platform: msg.platform, channelId: msg.channelId, threadId: msg.threadId },
            msg.content,
          );
          if (consumed) {
            log.info(
              { platform: msg.platform, channelId: msg.channelId },
              "Consumed message as ask_user reply",
            );
            return;
          }

          // Notify connected clients about the incoming message
          this.broadcast({
            type: "system",
            subtype: "message_received",
            message: `New message on ${msg.platform} from ${msg.userId}`,
            data: {
              platform: msg.platform,
              channelId: msg.channelId,
              userId: msg.userId,
              preview: msg.content.slice(0, 120),
              timestamp: msg.timestamp.toISOString(),
            },
          });

          // Observe mode: index without agent response
          if (adapter?.mode === "observe") {
            observeMessage(msg).catch((err) => log.error({ err }, "Observe indexing failed"));
            return;
          }

          // Consent gate: check if this platform is "notify_only"
          // Default channel is exempt (direct chat with agent)
          const isDefault = await this.isDefaultChannel(msg.platform, msg.channelId);
          if (!isDefault) {
            try {
              const { getConsentMode } = await import("../db/consent-config.ts");
              const consent = await getConsentMode(msg.platform);
              if (consent === "notify_only") {
                this.postNotifyOnlyToDefaultChannel(msg).catch((err) =>
                  log.error({ err }, "Notify-only notification failed"),
                );
                return; // don't process through agent
              }
            } catch {
              // consent config not available -- continue with default (always_ask)
            }
          }

          // Default channel: process immediately (no batching for direct agent chat)
          if (isDefault) {
            this.processAgentMessage(msg);
            return;
          }

          // Non-default: route through batcher to combine rapid sequential messages
          batcher.add(msg);
        })
        .catch((err) => {
          log.error({ err }, `Incoming hook transform failed`);
        });
    };

    // Slack user mode: load workspaces from DB, fall back to env var.
    // This block runs FIRST so we know whether Socket Mode is in use
    // (which means the SlackAdapter bot mode should NOT start -- two
    // Socket Mode connections on the same xapp- token compete for events).
    let usingSocketMode = false;
    {
      const { listWorkspaces, syncSlackConfigToFile } = await import("../db/slack-workspaces.ts");
      const workspaces = await listWorkspaces();

      // Sync DB tokens to ~/.nomos/slack/config.json for nomos-slack-mcp
      if (workspaces.length > 0) {
        try {
          await syncSlackConfigToFile();
        } catch (err) {
          log.warn({ err }, "Failed to sync Slack config to file");
        }
      }

      if (workspaces.length > 0) {
        // Check for app-level token (xapp-) for Socket Mode
        let slackAppToken: string | undefined;
        let slackBotToken: string | undefined;
        try {
          const { getIntegration } = await import("../db/integrations.ts");
          const slackIntegration = await getIntegration("slack");
          if (slackIntegration?.secrets) {
            const secrets = slackIntegration.secrets as Record<string, string>;
            if (secrets.app_token?.startsWith("xapp-")) slackAppToken = secrets.app_token;
            if (secrets.bot_token?.startsWith("xoxb-")) slackBotToken = secrets.bot_token;
          }
        } catch {
          // integrations not available
        }
        // Fall back to env
        if (!slackAppToken && process.env.SLACK_APP_TOKEN?.startsWith("xapp-")) {
          slackAppToken = process.env.SLACK_APP_TOKEN;
        }
        if (!slackBotToken) slackBotToken = process.env.SLACK_BOT_TOKEN;

        // Determine which workspace has the default channel
        let defaultChannelTeamId: string | null = null;
        try {
          const { getNotificationDefault } = await import("../db/notification-defaults.ts");
          const nd = await getNotificationDefault();
          if (nd?.platform.startsWith("slack-user:")) {
            defaultChannelTeamId = nd.platform.replace("slack-user:", "");
          }
        } catch {
          // not available
        }

        let pollingAdapterIndex = 0;
        for (const ws of workspaces) {
          const isDefaultWorkspace = ws.team_id === defaultChannelTeamId;

          // Use Socket Mode (real-time) for the default channel workspace
          // when an xapp- token is available. Polling for everything else.
          if (isDefaultWorkspace && slackAppToken) {
            usingSocketMode = true;
            log.info(`Using Socket Mode for workspace ${ws.team_id} (default channel)`);
            const adapter = new SlackUserAdapter({
              userToken: ws.access_token,
              appToken: slackAppToken,
              botToken: slackBotToken,
              teamId: ws.team_id,
              onMessage: enqueue,
              draftManager: this.draftManager,
            });
            adapter.setElicitationManager(this.elicitationManager);
            adapter.setOnAuthError((teamId, teamName, info) => {
              const event = {
                type: "system" as const,
                subtype: "auth_error",
                message: info?.reason ?? `Slack auth error for ${teamName} (${teamId})`,
                data: {
                  platform: `slack-user:${teamId}`,
                  teamId,
                  teamName,
                  kind: info?.kind ?? "user",
                },
              };
              this.wsServer.broadcast(event);
              this.grpcServer.broadcast(event);
            });
            this.channelManager.register(adapter);
            this.draftManager.registerSendFn(adapter.platform, (channelId, text, threadId) =>
              adapter.sendAsUser(channelId, text, threadId),
            );
          } else {
            // Stagger polling adapters 2 min apart to avoid rate limit bursts
            const staggerMs = pollingAdapterIndex * 2 * 60_000;
            pollingAdapterIndex++;
            const adapter = new SlackPollingAdapter({
              token: ws.access_token,
              cookie: ws.cookie_d,
              teamId: ws.team_id,
              startDelayMs: staggerMs,
              onMessage: enqueue,
              draftManager: this.draftManager,
              onAuthError: (teamId, teamName, info) => {
                const event = {
                  type: "system" as const,
                  subtype: "auth_error",
                  message:
                    info?.reason ??
                    `Slack session expired for ${teamName} (${teamId}) — run \`nomos slack auth\` to reconnect`,
                  data: {
                    platform: `slack-user:${teamId}`,
                    teamId,
                    teamName,
                    kind: info?.kind ?? "user",
                  },
                };
                this.wsServer.broadcast(event);
                this.grpcServer.broadcast(event);
              },
            });
            this.channelManager.register(adapter);
            this.draftManager.registerSendFn(adapter.platform, (channelId, text, threadId) =>
              adapter.sendAsUser(channelId, text, threadId),
            );
          }
        }

        // Slack bulk ingestion retired -- agent learns from conversations + draft edits
      } else if (
        process.env.SLACK_USER_TOKEN &&
        process.env.SLACK_APP_TOKEN &&
        FEATURES.byoChannelTokens()
      ) {
        // Backwards compat: single env var, no DB rows. BYO-only — in hosted
        // mode, tokens must come from DB rows deposited by the OAuth proxy.
        const adapter = new SlackUserAdapter({
          userToken: process.env.SLACK_USER_TOKEN,
          appToken: process.env.SLACK_APP_TOKEN,
          teamId: "default",
          onMessage: enqueue,
          draftManager: this.draftManager,
        });
        adapter.setElicitationManager(this.elicitationManager);
        this.channelManager.register(adapter);
        this.draftManager.registerSendFn(adapter.platform, (channelId, text, threadId) =>
          adapter.sendAsUser(channelId, text, threadId),
        );
      }
    }

    // Bot-mode SlackAdapter: only start if NOT using Socket Mode for user mode.
    // Two Socket Mode connections on the same xapp- token compete for events.
    // Hosted mode skips env-var paths — bot tokens come via OAuth proxy.
    if (
      process.env.SLACK_BOT_TOKEN &&
      process.env.SLACK_APP_TOKEN &&
      !usingSocketMode &&
      FEATURES.byoChannelTokens()
    ) {
      this.channelManager.register(new SlackAdapter(enqueue, this.draftManager));
    }

    if (process.env.DISCORD_BOT_TOKEN && FEATURES.byoChannelTokens()) {
      const adapter = new DiscordAdapter({
        onMessage: enqueue,
        draftManager: this.draftManager,
      });
      this.channelManager.register(adapter);
      // Register sendDirect (not send) to avoid infinite draft loop
      this.draftManager.registerSendFn("discord", (channelId, text, threadId) =>
        adapter.sendDirect({
          inReplyTo: "",
          platform: "discord",
          channelId,
          threadId,
          content: text,
        }),
      );
      // Discord ingestion removed -- agent learns from conversations, not history
    }

    if (process.env.TELEGRAM_BOT_TOKEN && FEATURES.byoChannelTokens()) {
      const adapter = new TelegramAdapter({
        onMessage: enqueue,
        draftManager: this.draftManager,
      });
      this.channelManager.register(adapter);
      this.draftManager.registerSendFn("telegram", (channelId, text, threadId) =>
        adapter.sendDirect({
          inReplyTo: "",
          platform: "telegram",
          channelId,
          threadId,
          content: text,
        }),
      );
      // Telegram ingestion removed -- agent learns from conversations, not history
    }

    // WhatsApp is always available (uses QR code auth)
    if (process.env.WHATSAPP_ENABLED === "true") {
      const adapter = new WhatsAppAdapter({
        onMessage: enqueue,
        draftManager: this.draftManager,
      });
      this.channelManager.register(adapter);
      this.draftManager.registerSendFn("whatsapp", (channelId, text, threadId) =>
        adapter.sendDirect({
          inReplyTo: "",
          platform: "whatsapp",
          channelId,
          threadId,
          content: text,
        }),
      );
    }

    // iMessage / Messages.app (macOS only — reads chat.db, sends via AppleScript)
    let imessageEnabled = process.env.IMESSAGE_ENABLED === "true";
    if (!imessageEnabled) {
      try {
        const { getIntegration } = await import("../db/integrations.ts");
        const imessageIntegration = await getIntegration("imessage");
        if (imessageIntegration?.enabled) {
          const cfg = imessageIntegration.config as Record<string, unknown>;
          imessageEnabled = cfg.enabled === "true";
        }
      } catch {
        // DB not available
      }
    }
    // Hosted mode never wires iMessage — Mac-only, requires local `imsg` CLI.
    if (imessageEnabled && process.platform === "darwin" && FEATURES.iMessageChannel()) {
      const adapter = new IMessageAdapter({
        onMessage: enqueue,
        draftManager: this.draftManager,
      });
      this.channelManager.register(adapter);
      // Register direct send function so DraftManager can send approved drafts
      // via iMessage (bypasses passive mode draft routing to avoid infinite loop)
      this.draftManager.registerSendFn("imessage", (channelId, text, threadId) =>
        adapter.sendDirect({
          inReplyTo: "",
          platform: "imessage",
          channelId,
          threadId,
          content: text,
        }),
      );

      // Delta sync on startup (full ingest only triggered from Settings UI)
      this.ingestScheduler.triggerStartup("imessage", "history", "imessage");
    }

    // Email adapter (IMAP/SMTP from integrations table)
    try {
      const { getIntegration } = await import("../db/integrations.ts");
      const emailIntegration = await getIntegration("email");
      if (emailIntegration?.enabled) {
        const config = emailIntegration.config as Record<string, unknown>;
        const secrets = emailIntegration.secrets as Record<string, string>;
        const adapter = new EmailAdapter({
          imap: {
            host: (config.imap_host as string) ?? "",
            port: (config.imap_port as number) ?? 993,
            secure: true,
            auth: { user: secrets.username ?? "", pass: secrets.password },
          },
          smtp: {
            host: (config.smtp_host as string) ?? "",
            port: (config.smtp_port as number) ?? 587,
            secure: false,
            auth: { user: secrets.username ?? "", pass: secrets.password },
            from: secrets.username ?? "",
          },
          userEmail: secrets.username ?? "",
          onMessage: enqueue,
          draftManager: this.draftManager,
        });
        this.channelManager.register(adapter);

        // Delta sync on startup (full ingest only triggered from Settings UI)
        this.ingestScheduler.triggerStartup("gmail", "history", "gmail");
      }
    } catch {
      // Email not configured — skip
    }
  }

  /**
   * Spawn `nomos ingest <subcommand> [...extraArgs]` as a child process.
   * Returns a promise that resolves when the subprocess exits.
   */
  private runIngestSubprocess(
    subcommand: string,
    label: string,
    extraArgs: string[] = [],
  ): Promise<void> {
    return new Promise<void>((resolve) => {
      // Resolve the main CLI entry point (src/index.ts or dist/index.js),
      // NOT process.argv[1] which may be src/daemon/index.ts (daemon-only,
      // no Commander.js routing -- would boot a second daemon instead of
      // running the ingest command).
      const thisFile = fileURLToPath(import.meta.url);
      const srcDir = path.dirname(thisFile); // src/daemon/
      let entryScript = path.resolve(srcDir, "../index.ts");
      if (!fs.existsSync(entryScript)) {
        // Built mode: dist/index.js
        entryScript = path.resolve(srcDir, "../index.js");
      }
      if (!fs.existsSync(entryScript)) {
        log.warn(`Cannot find CLI entry script for ingestion subprocess`);
        resolve();
        return;
      }

      log.info(`Starting ingestion for ${label} (subprocess)...`);
      this.broadcast({
        type: "system",
        subtype: "ingest_start",
        message: `Ingestion started for ${label}`,
        data: { platform: label, subcommand },
      });

      // When running via tsx (dev mode), the entry script is .ts and plain
      // node can't handle it.  Use --import tsx to register the loader.
      const args = entryScript.endsWith(".ts")
        ? ["--import", "tsx", entryScript, "ingest", subcommand, ...extraArgs]
        : [entryScript, "ingest", subcommand, ...extraArgs];

      const child = spawn(process.execPath, args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, FORCE_COLOR: "0" },
        detached: false,
      });

      child.stdout?.on("data", (data: Buffer) => {
        for (const line of data.toString().split("\n")) {
          const trimmed = line.trim();
          if (trimmed) log.info(`[ingest:${subcommand}] ${trimmed}`);
        }
      });

      child.stderr?.on("data", (data: Buffer) => {
        for (const line of data.toString().split("\n")) {
          const trimmed = line.trim();
          if (trimmed) log.error(`[ingest:${subcommand}] ${trimmed}`);
        }
      });

      child.on("exit", (code) => {
        if (code === 0) {
          log.info(`Ingestion complete for ${label}`);
          this.broadcast({
            type: "system",
            subtype: "ingest_complete",
            message: `Ingestion complete for ${label}`,
            data: { platform: label, success: true },
          });
          // Re-register delta sync cron jobs in case a new full ingest completed
          registerDeltaSyncJobs().catch(() => {});
        } else {
          log.error(`Ingestion for ${label} exited with code ${code}`);
          this.broadcast({
            type: "system",
            subtype: "ingest_complete",
            message: `Ingestion failed for ${label} (exit code ${code})`,
            data: { platform: label, success: false, exitCode: code },
          });
        }
        resolve();
      });

      child.on("error", (err) => {
        log.error({ err: err.message }, `Failed to spawn ingestion for ${label}`);
        this.broadcast({
          type: "system",
          subtype: "ingest_complete",
          message: `Ingestion failed for ${label}: ${err.message}`,
          data: { platform: label, success: false, error: err.message },
        });
        resolve();
      });
    });
  }

  /** Check if a message is in the default notification channel (exempt from consent). */
  private async isDefaultChannel(platform: string, channelId: string): Promise<boolean> {
    const nd = await this.getDefaultChannel();
    if (!nd) return false;
    return nd.platform === platform && nd.channelId === channelId;
  }

  /** Get bot token from integrations table or env. */
  private async getBotToken(): Promise<string | undefined> {
    if (process.env.SLACK_BOT_TOKEN) return process.env.SLACK_BOT_TOKEN;
    try {
      const { getIntegration } = await import("../db/integrations.ts");
      const slack = await getIntegration("slack");
      return (slack?.secrets as Record<string, string>)?.bot_token;
    } catch {
      return undefined;
    }
  }

  /** Get default notification channel config. */
  private async getDefaultChannel(): Promise<{ channelId: string; platform: string } | null> {
    try {
      const { getNotificationDefault } = await import("../db/notification-defaults.ts");
      return await getNotificationDefault();
    } catch {
      return null;
    }
  }

  /** Platform display names for notifications. */
  private static readonly PLATFORM_LABELS: Record<string, string> = {
    slack: "Slack",
    discord: "Discord",
    telegram: "Telegram",
    imessage: "iMessage",
    email: "Email",
    whatsapp: "WhatsApp",
    cate: "CATE",
  };

  private platformLabel(platform: string): string {
    const base = platform.split(":")[0].replace("slack-user", "slack");
    return Gateway.PLATFORM_LABELS[base] ?? platform;
  }

  /**
   * Post a draft notification to the default Slack channel with Approve/Edit/Decline buttons.
   * Replaces the old sendSlackDraftNotification (which posted to a bot DM).
   */
  private async sendDraftNotificationToDefaultChannel(
    draft: DraftRow,
    context: Record<string, unknown>,
  ): Promise<void> {
    const nd = await this.getDefaultChannel();
    if (!nd) return;

    const botToken = await this.getBotToken();
    if (!botToken) return;

    const { WebClient } = await import("@slack/web-api");
    const client = new WebClient(botToken);

    const senderName = (context.senderName as string) ?? draft.user_id;
    const workspaceName = (context.workspaceName as string) ?? this.platformLabel(draft.platform);
    const messageType = (context.messageType as string) ?? "message";
    const channelName = (context.channelName as string) ?? "";
    const originalMessage = (context.originalMessage as string) ?? "";

    const contextLine =
      messageType === "dm"
        ? `${workspaceName} DM from *${senderName}*`
        : messageType === "mention"
          ? `${workspaceName} @mention in #${channelName} from *${senderName}*`
          : `${workspaceName} message from *${senderName}*`;

    const draftPreview =
      draft.content.length > 2000 ? draft.content.slice(0, 2000) + "..." : draft.content;

    // Build blocks: context line, original message (if available), draft, actions
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const blocks: any[] = [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${contextLine}*`,
        },
      },
    ];

    // Show the original incoming message for context
    if (originalMessage) {
      const msgPreview =
        originalMessage.length > 500 ? originalMessage.slice(0, 500) + "..." : originalMessage;
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `> ${msgPreview.replace(/\n/g, "\n> ")}`,
        },
      });
      blocks.push({ type: "divider" });
    }

    blocks.push(
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Draft response:*\n${draftPreview}`,
        },
      },
      {
        type: "actions",
        block_id: `draft_${draft.id}`,
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Approve" },
            style: "primary",
            action_id: "approve_draft",
            value: draft.id,
          },
          {
            type: "button",
            text: { type: "plain_text", text: "Edit & Send" },
            action_id: "edit_draft",
            value: draft.id,
          },
          {
            type: "button",
            text: { type: "plain_text", text: "Decline" },
            style: "danger",
            action_id: "reject_draft",
            value: draft.id,
          },
        ],
      },
    );

    await client.chat.postMessage({
      channel: nd.channelId,
      text: `Draft response for ${contextLine}`,
      blocks,
    });
  }

  /**
   * Post a FYI notification to the default channel (for auto-approved messages).
   */
  private async sendFyiNotificationToDefaultChannel(
    platform: string,
    channelId: string,
    content: string,
    context: Record<string, unknown>,
  ): Promise<void> {
    const nd = await this.getDefaultChannel();
    if (!nd) return;

    const botToken = await this.getBotToken();
    if (!botToken) return;

    const { WebClient } = await import("@slack/web-api");
    const client = new WebClient(botToken);

    const senderName = (context.senderName as string) ?? channelId;
    const workspaceName = (context.workspaceName as string) ?? this.platformLabel(platform);
    const preview = content.length > 200 ? content.slice(0, 200) + "..." : content;

    await client.chat.postMessage({
      channel: nd.channelId,
      text: `Auto-replied to ${senderName} on ${workspaceName}: ${preview}`,
    });
  }

  /**
   * Post a "notify only" notification to the default channel (no draft, no response).
   */
  async postNotifyOnlyToDefaultChannel(msg: IncomingMessage): Promise<void> {
    const nd = await this.getDefaultChannel();
    if (!nd) return;

    const botToken = await this.getBotToken();
    if (!botToken) return;

    const { WebClient } = await import("@slack/web-api");
    const client = new WebClient(botToken);

    const senderName = (msg.metadata?.senderName as string) ?? msg.userId;
    const workspaceName =
      (msg.metadata?.workspaceName as string) ?? this.platformLabel(msg.platform);
    const preview = msg.content.length > 300 ? msg.content.slice(0, 300) + "..." : msg.content;

    await client.chat.postMessage({
      channel: nd.channelId,
      text: `${workspaceName} message from ${senderName}:\n${preview}`,
    });
  }
}
