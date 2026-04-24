/**
 * Gateway: main daemon orchestrator.
 *
 * Boots all subsystems in order, wires them together, and handles
 * graceful shutdown.
 */

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AgentRuntime } from "./agent-runtime.ts";
import { MessageQueue } from "./message-queue.ts";
import { DaemonWebSocketServer } from "./websocket-server.ts";
import { GrpcServer } from "./grpc-server.ts";
import { ChannelManager } from "./channel-manager.ts";
import { CronEngine } from "./cron-engine.ts";
import { DraftManager } from "./draft-manager.ts";
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
import {
  initCATEIntegration,
  stopCATEIntegration,
  type CATEIntegration,
} from "../cate/integration.ts";
import type { IncomingMessage, AgentEvent } from "./types.ts";
import type { DraftRow } from "../db/drafts.ts";

export interface GatewayOptions {
  /** WebSocket server port (default: 8765) */
  port?: number;
  /** gRPC server port (default: port + 1, i.e., 8766) */
  grpcPort?: number;
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
  private channelManager: ChannelManager;
  private cronEngine: CronEngine;
  private draftManager: DraftManager;
  private settingsProcess: ChildProcess | null = null;
  private cateIntegration: CATEIntegration | null = null;
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

    // 5. Create channel manager
    this.channelManager = new ChannelManager();

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
    console.log("[gateway] Starting daemon...");

    // Write PID file
    writePidFile();

    // Install signal handlers for graceful shutdown
    installSignalHandlers(() => this.stop());

    // Initialize agent runtime (loads config, runs migrations)
    await this.runtime.initialize();

    // Sync config files (SOUL.md, TOOLS.md, IDENTITY.md, skills) disk <-> DB
    try {
      const { syncAllFiles } = await import("../config/file-sync.ts");
      await syncAllFiles();
    } catch (err) {
      console.warn("[gateway] File sync failed:", err instanceof Error ? err.message : err);
    }

    // Verify LLM access before starting services
    await this.checkLlmAccess();

    // Seed autonomous loops (idempotent — safe to call on every start)
    try {
      const { seedAutonomousLoops } = await import("./autonomous.ts");
      await seedAutonomousLoops();
    } catch (err) {
      console.warn("[gateway] Failed to seed autonomous loops:", err);
    }

    // Start WebSocket server
    await this.wsServer.start();

    // Start gRPC server
    await this.grpcServer.start();

    // Register command handler for hot-reload and ingestion triggers
    this.grpcServer.onCommand(async (command) => {
      if (command === "reload-slack-workspaces") {
        const added = await this.reloadSlackWorkspaces();
        return added.length > 0
          ? `Loaded ${added.length} workspace(s): ${added.join(", ")}`
          : "No new workspaces to load";
      }

      // trigger-ingest:<platform> -- start full ingestion
      if (command.startsWith("trigger-ingest:")) {
        const platform = command.slice("trigger-ingest:".length);
        const sub = IngestScheduler.platformToSubcommand(platform);
        if (!sub) return `Unknown platform: ${platform}`;
        this.ingestScheduler.triggerFull(platform, "history", sub);
        return `Full ingestion triggered for ${platform}`;
      }

      // trigger-delta:<platform> -- start delta sync
      if (command.startsWith("trigger-delta:")) {
        const platform = command.slice("trigger-delta:".length);
        const sub = IngestScheduler.platformToSubcommand(platform);
        if (!sub) return `Unknown platform: ${platform}`;
        this.ingestScheduler.triggerDelta(platform, "history", sub);
        return `Delta sync triggered for ${platform}`;
      }

      return `Unknown command: ${command}`;
    });

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
        console.warn("[gateway] Cron engine failed to start:", err);
      }
    }

    // Register delta sync cron jobs for ingestion
    try {
      await registerDeltaSyncJobs();
    } catch (err) {
      console.warn("[gateway] Delta sync registration failed:", err);
    }

    // Register proactive feature cron jobs
    try {
      await registerProactiveJobs();
    } catch (err) {
      console.warn("[gateway] Proactive jobs registration failed:", err);
    }

    // Register wiki compilation cron job (compile knowledge every 6 hours)
    try {
      const { CronStore } = await import("../cron/store.ts");
      const cronStore = new CronStore();
      const existingWikiJob = await cronStore.getJobByName("wiki-compile");
      if (!existingWikiJob) {
        await cronStore.createJob({
          name: "wiki-compile",
          schedule: "1h",
          scheduleType: "every",
          sessionTarget: "isolated",
          deliveryMode: "none",
          prompt: "__wiki_compile__",
          enabled: true,
          errorCount: 0,
        });
        console.log("[gateway] Registered wiki compilation cron job (every 6h)");
        process.emit("cron:refresh" as never);
      }
    } catch (err) {
      console.warn("[gateway] Wiki cron registration failed:", err);
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
            userId: envelope.parties.from.did,
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
      console.warn("[gateway] CATE integration failed to start:", err);
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
    console.log("[gateway] Daemon is running");
    console.log(`[gateway]   gRPC:      localhost:${grpcPort}`);
    console.log(`[gateway]   WebSocket: ws://localhost:${wsPort}`);
    if (this.settingsProcess) {
      console.log(`[gateway]   Settings:  http://localhost:${settingsPort}`);
    }
    console.log(`[gateway]   Channels: ${platforms.length > 0 ? platforms.join(", ") : "none"}`);
  }

  /** Stop the daemon gracefully. */
  async stop(): Promise<void> {
    console.log("[gateway] Stopping daemon...");

    // Stop in reverse order
    if (this.cateIntegration) {
      await stopCATEIntegration(this.cateIntegration);
    }
    this.stopSettingsServer();
    this.cronEngine.stop();
    await this.channelManager.stop();
    await this.grpcServer.stop();
    await this.wsServer.stop();
    await closeBrowser();

    console.log("[gateway] Daemon stopped");
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
                console.error("[gateway] Memory indexing failed:", err),
              );
            })
            .catch(async (err) => {
              await responder?.finalize("Sorry, an error occurred.");
              console.error(`[gateway] Failed to process message from ${msg.platform}:`, err);
            });
        })
        .catch((err) => {
          console.error(`[gateway] Incoming hook transform failed:`, err);
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
        onAuthError: (teamId, teamName) => {
          const event = {
            type: "system" as const,
            subtype: "auth_error",
            message: `Slack session expired for ${teamName} (${teamId}) — run \`nomos slack auth\` to reconnect`,
            data: { platform: `slack-user:${teamId}`, teamId, teamName },
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
      console.error("[gateway] Failed to reload workspace MCP servers:", err);
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
        console.log(`[gateway] Auto-set notification default: DM in ${ws.team_name}`);
      }
    } catch {
      // Non-critical
    }

    if (changes.length > 0) {
      console.log(`[gateway] Slack workspace sync: ${changes.join(", ")}`);
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
    const settingsDir = this.findSettingsDir();
    if (!settingsDir) {
      console.warn("[gateway] Settings directory not found — skipping Settings UI");
      return;
    }

    const port = String(this.options.settingsPort ?? 3456);

    // Check if .next build exists
    const buildId = path.join(settingsDir, ".next", "BUILD_ID");
    if (!fs.existsSync(buildId)) {
      console.warn("[gateway] Settings UI not built — run `cd settings && pnpm build`");
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
        env: { ...process.env, PORT: port, HOSTNAME: "0.0.0.0" },
      });
    } else {
      // Fallback: find the next binary
      const nextBinCandidates = [
        path.join(settingsDir, "node_modules", ".bin", "next"),
        path.join(settingsDir, "..", "node_modules", ".bin", "next"),
      ];
      const nextBin = nextBinCandidates.find((p) => fs.existsSync(p));
      if (!nextBin) {
        console.warn("[gateway] Next.js binary not found — skipping Settings UI");
        return;
      }
      child = spawn(nextBin, ["start", "--port", port], {
        cwd: settingsDir,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PORT: port },
      });
    }

    child.stdout?.on("data", (data: Buffer) => {
      const line = data.toString().trim();
      if (line) console.log(`[settings] ${line}`);
    });

    child.stderr?.on("data", (data: Buffer) => {
      const line = data.toString().trim();
      if (line) console.error(`[settings] ${line}`);
    });

    child.on("exit", (code, signal) => {
      if (this.settingsProcess === child) {
        console.warn(`[gateway] Settings UI exited (code=${code}, signal=${signal})`);
        this.settingsProcess = null;
      }
    });

    this.settingsProcess = child;
    console.log(`[gateway] Settings UI starting on port ${port}`);
  }

  /** Stop the Settings UI child process. */
  private stopSettingsServer(): void {
    if (this.settingsProcess) {
      console.log("[gateway] Stopping Settings UI...");
      this.settingsProcess.kill("SIGTERM");
      this.settingsProcess = null;
    }
  }

  /** Verify LLM API access works before starting services. */
  private async checkLlmAccess(): Promise<void> {
    console.log("[gateway] Checking LLM access...");

    const apiKey = process.env.ANTHROPIC_API_KEY;
    const baseUrl = process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com";
    const useVertex = process.env.CLAUDE_CODE_USE_VERTEX === "1";

    if (useVertex) {
      console.log("[gateway] Using Vertex AI — skipping API key check");
      return;
    }

    if (!apiKey) {
      console.warn("[gateway] ⚠ No ANTHROPIC_API_KEY set — LLM calls will fail");
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
        console.log("[gateway] LLM access verified");
      } else {
        const body = await res.text();
        console.error(`[gateway] LLM access check failed (${res.status}): ${body}`);
        console.error("[gateway] Verify ANTHROPIC_API_KEY and model configuration in .env");
        console.warn("[gateway] ⚠ Daemon starting without verified LLM access");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[gateway] LLM access check failed: ${message}`);
      console.warn("[gateway] ⚠ Daemon starting without verified LLM access");
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
          console.error("[gateway] Memory indexing failed:", err),
        );
      })
      .catch(async (err) => {
        // Update placeholder with error if possible
        await responder?.finalize("Sorry, an error occurred.");
        console.error(`[gateway] Failed to process message from ${msg.platform}:`, err);
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
            observeMessage(msg).catch((err) =>
              console.error("[gateway] Observe indexing failed:", err),
            );
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
                  console.error("[gateway] Notify-only notification failed:", err),
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
          console.error(`[gateway] Incoming hook transform failed:`, err);
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
          console.warn("[gateway] Failed to sync Slack config to file:", err);
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
            console.log(
              `[gateway] Using Socket Mode for workspace ${ws.team_id} (default channel)`,
            );
            const adapter = new SlackUserAdapter({
              userToken: ws.access_token,
              appToken: slackAppToken,
              botToken: slackBotToken,
              teamId: ws.team_id,
              onMessage: enqueue,
              draftManager: this.draftManager,
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
              onAuthError: (teamId, teamName) => {
                const event = {
                  type: "system" as const,
                  subtype: "auth_error",
                  message: `Slack session expired for ${teamName} (${teamId}) — run \`nomos slack auth\` to reconnect`,
                  data: { platform: `slack-user:${teamId}`, teamId, teamName },
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
      } else if (process.env.SLACK_USER_TOKEN && process.env.SLACK_APP_TOKEN) {
        // Backwards compat: single env var, no DB rows
        const adapter = new SlackUserAdapter({
          userToken: process.env.SLACK_USER_TOKEN,
          appToken: process.env.SLACK_APP_TOKEN,
          teamId: "default",
          onMessage: enqueue,
          draftManager: this.draftManager,
        });
        this.channelManager.register(adapter);
        this.draftManager.registerSendFn(adapter.platform, (channelId, text, threadId) =>
          adapter.sendAsUser(channelId, text, threadId),
        );
      }
    }

    // Bot-mode SlackAdapter: only start if NOT using Socket Mode for user mode.
    // Two Socket Mode connections on the same xapp- token compete for events.
    if (process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN && !usingSocketMode) {
      this.channelManager.register(new SlackAdapter(enqueue, this.draftManager));
    }

    if (process.env.DISCORD_BOT_TOKEN) {
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

    if (process.env.TELEGRAM_BOT_TOKEN) {
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
    if (imessageEnabled && process.platform === "darwin") {
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
        console.warn(`[gateway] Cannot find CLI entry script for ingestion subprocess`);
        resolve();
        return;
      }

      console.log(`[gateway] Starting ingestion for ${label} (subprocess)...`);
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
          if (trimmed) console.log(`[ingest:${subcommand}] ${trimmed}`);
        }
      });

      child.stderr?.on("data", (data: Buffer) => {
        for (const line of data.toString().split("\n")) {
          const trimmed = line.trim();
          if (trimmed) console.error(`[ingest:${subcommand}] ${trimmed}`);
        }
      });

      child.on("exit", (code) => {
        if (code === 0) {
          console.log(`[gateway] Ingestion complete for ${label}`);
          this.broadcast({
            type: "system",
            subtype: "ingest_complete",
            message: `Ingestion complete for ${label}`,
            data: { platform: label, success: true },
          });
          // Re-register delta sync cron jobs in case a new full ingest completed
          registerDeltaSyncJobs().catch(() => {});
        } else {
          console.error(`[gateway] Ingestion for ${label} exited with code ${code}`);
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
        console.error(`[gateway] Failed to spawn ingestion for ${label}:`, err.message);
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
