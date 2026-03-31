/**
 * Gateway: main daemon orchestrator.
 *
 * Boots all subsystems in order, wires them together, and handles
 * graceful shutdown.
 */

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
import { indexConversationTurn } from "./memory-indexer.ts";
import { closeBrowser } from "../sdk/browser.ts";
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
}

export class Gateway {
  private runtime: AgentRuntime;
  private messageQueue: MessageQueue;
  private wsServer: DaemonWebSocketServer;
  private grpcServer: GrpcServer;
  private channelManager: ChannelManager;
  private cronEngine: CronEngine;
  private draftManager: DraftManager;
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
      notifySlack: (userId, draft) => this.sendSlackDraftNotification(userId, draft),
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

    // 6. Create cron engine
    this.cronEngine = new CronEngine(this.messageQueue, this.channelManager);
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

    // Register command handler for hot-reload
    this.grpcServer.onCommand(async (command) => {
      if (command === "reload-slack-workspaces") {
        const added = await this.reloadSlackWorkspaces();
        return added.length > 0
          ? `Loaded ${added.length} workspace(s): ${added.join(", ")}`
          : "No new workspaces to load";
      }
      return `Unknown command: ${command}`;
    });

    // Register and start channel adapters
    if (!this.options.skipChannels) {
      await this.registerChannelAdapters();
      await this.channelManager.start();
    }

    // Start cron engine
    if (!this.options.skipCron) {
      try {
        await this.cronEngine.start();
      } catch (err) {
        console.warn("[gateway] Cron engine failed to start:", err);
      }
    }

    const platforms = this.channelManager.listPlatforms();
    const wsPort = this.options.port ?? 8765;
    const grpcPort = this.options.grpcPort ?? wsPort + 1;
    console.log("[gateway] Daemon is running");
    console.log(`[gateway]   gRPC:      localhost:${grpcPort}`);
    console.log(`[gateway]   WebSocket: ws://localhost:${wsPort}`);
    console.log(`[gateway]   Channels: ${platforms.length > 0 ? platforms.join(", ") : "none"}`);
  }

  /** Stop the daemon gracefully. */
  async stop(): Promise<void> {
    console.log("[gateway] Stopping daemon...");

    // Stop in reverse order
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

      if (ws.access_token.startsWith("xoxc-") || ws.cookie_d) {
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
        changes.push(`${existing ? "refreshed" : "added"} ${ws.team_name} (${ws.team_id})`);
      } else if (process.env.SLACK_APP_TOKEN) {
        const adapter = new SlackUserAdapter({
          userToken: ws.access_token,
          appToken: process.env.SLACK_APP_TOKEN,
          teamId: ws.team_id,
          onMessage: enqueue,
          draftManager: this.draftManager,
        });
        await this.channelManager.registerAndStart(adapter);
        this.draftManager.registerSendFn(adapter.platform, (channelId, text, threadId) =>
          adapter.sendAsUser(channelId, text, threadId),
        );
        changes.push(`${existing ? "refreshed" : "added"} ${ws.team_name} (${ws.team_id})`);
      }
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

  /** Register available channel adapters based on env vars. */
  private async registerChannelAdapters(): Promise<void> {
    const enqueue = (rawMsg: IncomingMessage) => {
      // Run incoming transform hooks (fire-and-forget the async, enqueue immediately)
      this.channelManager
        .transformIncoming(rawMsg)
        .then((msg) => {
          const sessionKey = `${msg.platform}:${msg.channelId}`;
          const adapter = this.channelManager.getAdapter(msg.platform);

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
        })
        .catch((err) => {
          console.error(`[gateway] Incoming hook transform failed:`, err);
        });
    };

    // Only register adapters whose tokens are present
    if (process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN) {
      this.channelManager.register(new SlackAdapter(enqueue, this.draftManager));
    }

    // Slack user mode: load workspaces from DB, fall back to env var
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
        for (const ws of workspaces) {
          if (ws.access_token.startsWith("xoxc-") || ws.cookie_d) {
            // Browser-extracted session token → use polling adapter (no Slack app needed)
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
            this.channelManager.register(adapter);
            this.draftManager.registerSendFn(adapter.platform, (channelId, text, threadId) =>
              adapter.sendAsUser(channelId, text, threadId),
            );
          } else if (process.env.SLACK_APP_TOKEN) {
            // OAuth xoxp- token → use Socket Mode adapter (requires Slack app)
            const adapter = new SlackUserAdapter({
              userToken: ws.access_token,
              appToken: process.env.SLACK_APP_TOKEN,
              teamId: ws.team_id,
              onMessage: enqueue,
              draftManager: this.draftManager,
            });
            this.channelManager.register(adapter);
            this.draftManager.registerSendFn(adapter.platform, (channelId, text, threadId) =>
              adapter.sendAsUser(channelId, text, threadId),
            );
          } else {
            console.warn(
              `[gateway] Skipping workspace ${ws.team_name} (${ws.team_id}): xoxp- token requires SLACK_APP_TOKEN`,
            );
          }
        }
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

    if (process.env.DISCORD_BOT_TOKEN) {
      this.channelManager.register(new DiscordAdapter(enqueue));
    }

    if (process.env.TELEGRAM_BOT_TOKEN) {
      this.channelManager.register(new TelegramAdapter(enqueue));
    }

    // WhatsApp is always available (uses QR code auth)
    if (process.env.WHATSAPP_ENABLED === "true") {
      this.channelManager.register(new WhatsAppAdapter(enqueue));
    }

    // iMessage (macOS only — reads chat.db, sends via AppleScript)
    if (process.env.IMESSAGE_ENABLED === "true" && process.platform === "darwin") {
      this.channelManager.register(new IMessageAdapter(enqueue));
    }
  }

  /** Send a Slack bot DM to the user with Block Kit approval buttons. */
  private async sendSlackDraftNotification(userId: string, draft: DraftRow): Promise<void> {
    const botToken = process.env.SLACK_BOT_TOKEN;
    if (!botToken) return;

    const slackAdapter = this.channelManager.getAdapter("slack") as SlackAdapter | undefined;
    if (!slackAdapter) return;

    // Open a DM channel with the user
    const { WebClient } = await import("@slack/web-api");
    const client = new WebClient(botToken);
    const dm = await client.conversations.open({ users: userId });
    const dmChannel = dm.channel?.id;
    if (!dmChannel) return;

    const contextLabel =
      (draft.context as Record<string, unknown>).messageType === "dm"
        ? `DM from ${(draft.context as Record<string, unknown>).senderName ?? "unknown"}`
        : `Mention in #${(draft.context as Record<string, unknown>).channelName ?? "channel"}`;

    const preview =
      draft.content.length > 2900 ? draft.content.slice(0, 2900) + "..." : draft.content;

    await client.chat.postMessage({
      channel: dmChannel,
      text: `Draft response ready (${draft.id.slice(0, 8)})`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Draft response ready*\n_${contextLabel}_`,
          },
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `\`\`\`\n${preview}\n\`\`\``,
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
              text: { type: "plain_text", text: "Reject" },
              style: "danger",
              action_id: "reject_draft",
              value: draft.id,
            },
          ],
        },
      ],
    });
  }
}
