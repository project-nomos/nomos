/**
 * Slack Polling adapter.
 *
 * Uses xoxc- session tokens (extracted via browser login) to poll for
 * new DMs and @mentions. No Slack app or Socket Mode required — just
 * a browser session token + cookie.
 *
 * Also works with xoxp- tokens (cookie not needed in that case).
 *
 * Rate limit strategy:
 * - All adapter instances share a global mutex so only one workspace
 *   polls at a time (Slack Tier 3: 50 req/min is per-app, not per-token).
 * - Only "active" channels (recent messages) are polled every cycle.
 * - A full scan of all channels runs every FULL_SCAN_EVERY polls.
 * - Inter-call delay of 2s (~30 req/min) leaves headroom for MCP tool calls.
 */

import { WebClient } from "@slack/web-api";
import type { ChannelAdapter, IncomingMessage, OutgoingMessage } from "../types.ts";
import type { DraftManager } from "../draft-manager.ts";
import { randomUUID } from "node:crypto";
import { markdownToSlackMrkdwn } from "./slack-mrkdwn.ts";

export interface SlackPollingAdapterOptions {
  token: string;
  cookie?: string;
  teamId: string;
  pollIntervalMs?: number;
  /** Delay before the first poll (for staggering multiple workspaces). */
  startDelayMs?: number;
  onMessage: (msg: IncomingMessage) => void;
  draftManager: DraftManager;
  /** Called when the token becomes invalid (expired session). */
  onAuthError?: (teamId: string, teamName: string) => void;
}

export class SlackPollingAdapter implements ChannelAdapter {
  private readonly teamId: string;
  private readonly token: string;
  private readonly cookie?: string;
  private readonly pollIntervalMs: number;
  private client: WebClient | null = null;
  private userId: string | null = null;
  private teamName: string | null = null;
  private onMessage: (msg: IncomingMessage) => void;
  private draftManager: DraftManager;
  private onAuthError?: (teamId: string, teamName: string) => void;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private polling = false;
  private authErrorFired = false;
  private consecutiveErrors = 0;

  // Track last seen timestamp per channel to fetch only new messages
  private lastSeenTs = new Map<string, string>();

  // Cached channel lists (refreshed every CHANNEL_REFRESH_INTERVAL_MS)
  private cachedDMChannels: string[] = [];
  private cachedMemberChannels: string[] = [];
  private channelListLastFetched = 0;

  // Default notification channel -- treated as a direct channel (no @mention required)
  private defaultChannelId: string | null = null;
  // Bot client for posting agent responses with the bot identity (not as the user)
  private botClient: WebClient | null = null;
  private botUserId: string | null = null;
  // All known user IDs for the owner across workspaces
  private ownUserIds = new Set<string>();
  private static readonly CHANNEL_REFRESH_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
  private static readonly INTER_CALL_DELAY_MS = 3000; // ~20 req/min, conservative for Tier 3
  private static readonly FULL_SCAN_DELAY_MS = 5000; // Slower during full scans

  // Active channel tracking: only poll channels with recent messages
  private activeChannels = new Set<string>();
  private pollCount = 0;
  private static readonly FULL_SCAN_EVERY = 60; // Full scan every 60th poll (~5h at 5min intervals)

  // Global mutex: only one adapter instance polls at a time across all workspaces.
  // Slack rate limits are per-app (OAuth client), shared across all tokens.
  private static pollMutex: Promise<void> = Promise.resolve();

  // Cache for user/channel name lookups
  private userNameCache = new Map<string, string>();
  private channelNameCache = new Map<string, string>();

  // Cache last incoming message context per channel so send() can enrich drafts
  private lastIncomingContext = new Map<string, Record<string, unknown>>();

  get platform(): string {
    return `slack-user:${this.teamId}`;
  }

  private readonly startDelayMs: number;

  constructor(options: SlackPollingAdapterOptions) {
    this.token = options.token;
    this.cookie = options.cookie;
    this.teamId = options.teamId;
    this.pollIntervalMs = options.pollIntervalMs ?? 5 * 60_000; // 5 min (was 60s)
    this.startDelayMs = options.startDelayMs ?? 0;
    this.onMessage = options.onMessage;
    this.draftManager = options.draftManager;
    this.onAuthError = options.onAuthError;
  }

  async start(): Promise<void> {
    // Create WebClient with cookie header if using xoxc- token
    const clientOptions: ConstructorParameters<typeof WebClient>[1] = {};
    if (this.cookie && this.token.startsWith("xoxc-")) {
      clientOptions.headers = { Cookie: `d=${this.cookie}` };
    }
    this.client = new WebClient(this.token, clientOptions);

    // Resolve own user ID
    const auth = await this.client.auth.test();
    this.userId = (auth.user_id as string) ?? null;
    if (!this.userId) {
      throw new Error(`Could not resolve user ID from token for team ${this.teamId}`);
    }

    const userName = (auth.user as string) ?? this.userId;
    this.teamName = (auth.team as string) ?? this.teamId;
    console.log(`[slack-polling] Running (user: ${userName}, team: ${this.teamId})`);

    this.running = true;

    // Create bot client for posting agent responses with distinct identity.
    // Check env first, then the integrations table (Settings UI stores it there).
    let botToken = process.env.SLACK_BOT_TOKEN;
    if (!botToken) {
      try {
        const { getIntegration } = await import("../../db/integrations.ts");
        const slackIntegration = await getIntegration("slack");
        if (slackIntegration?.secrets) {
          botToken = (slackIntegration.secrets as Record<string, string>).bot_token;
        }
      } catch {
        // integrations table not available
      }
    }
    if (botToken) {
      this.botClient = new WebClient(botToken);
      try {
        const botAuth = await this.botClient.auth.test();
        this.botUserId = (botAuth.user_id as string) ?? null;
        console.log(`[slack-polling] Bot identity loaded (${this.botUserId})`);
      } catch {
        console.warn(`[slack-polling] Bot token auth failed -- agent will post as user`);
        this.botClient = null;
      }
    }

    // Load all known user IDs for the owner across workspaces
    if (this.userId) this.ownUserIds.add(this.userId);
    if (this.botUserId) this.ownUserIds.add(this.botUserId);
    try {
      const { listIntegrationsByPrefix } = await import("../../db/integrations.ts");
      const workspaces = await listIntegrationsByPrefix("slack-ws:");
      for (const ws of workspaces) {
        const uid = (ws.metadata as Record<string, unknown>)?.user_id;
        if (typeof uid === "string") this.ownUserIds.add(uid);
      }
    } catch {
      // integrations not available
    }

    // Load default notification channel -- messages there are treated like DMs
    try {
      const { getNotificationDefault } = await import("../../db/notification-defaults.ts");
      const nd = await getNotificationDefault();
      if (nd && nd.platform === this.platform) {
        this.defaultChannelId = nd.channelId;
        console.log(
          `[slack-polling] Default channel: ${nd.channelId} (${nd.label ?? "unlabeled"})`,
        );
      }
    } catch {
      // notification defaults not available
    }

    // Initial poll to set baselines (don't process old messages)
    await this.initializeBaselines();

    // Start polling after optional stagger delay (prevents burst of API calls
    // when multiple workspaces start simultaneously)
    const startPolling = () => {
      console.log(
        `[slack-polling] Polling started for team ${this.teamId} (every ${Math.round(this.pollIntervalMs / 1000)}s)`,
      );
      // Run first poll immediately, then on interval
      this.poll().catch((err) =>
        console.error(`[slack-polling] Poll error (team ${this.teamId}):`, err),
      );
      this.pollTimer = setInterval(() => {
        this.poll().catch((err) => {
          console.error(`[slack-polling] Poll error (team ${this.teamId}):`, err);
        });
      }, this.pollIntervalMs);
    };

    if (this.startDelayMs > 0) {
      console.log(
        `[slack-polling] Delaying poll start by ${Math.round(this.startDelayMs / 1000)}s for team ${this.teamId}`,
      );
      setTimeout(startPolling, this.startDelayMs);
    } else {
      startPolling();
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  async send(message: OutgoingMessage): Promise<void> {
    if (!this.userId) return;

    // Default channel: the user is chatting with the agent directly,
    // so respond immediately instead of creating a draft for approval.
    // Use bot token if available so the agent has its own identity.
    if (message.channelId === this.defaultChannelId) {
      await this.sendAsAgent(message.channelId, message.content, message.threadId);
      return;
    }

    // Merge cached incoming context (senderName, messageType, workspaceName, originalMessage)
    const cachedCtx = this.lastIncomingContext.get(message.channelId) ?? {};
    const context: Record<string, unknown> = {
      channelId: message.channelId,
      threadId: message.threadId,
      workspaceName: this.teamName ?? this.teamId,
      ...cachedCtx,
    };

    // Clear cache after use (don't leak context into next conversation)
    this.lastIncomingContext.delete(message.channelId);

    await this.draftManager.createDraft(message, this.userId, context);
  }

  /**
   * Send a message as the authenticated user (called after draft approval).
   */
  async sendAsUser(channelId: string, text: string, threadId?: string): Promise<void> {
    if (!this.client) return;
    await this.client.chat.postMessage({
      channel: channelId,
      text: markdownToSlackMrkdwn(text),
      thread_ts: threadId,
    });
  }

  /**
   * Send a message as the agent (bot identity).
   * Falls back to user token if no bot token is configured.
   */
  async sendAsAgent(channelId: string, text: string, threadId?: string): Promise<void> {
    const client = this.botClient ?? this.client;
    if (!client) return;
    await client.chat.postMessage({
      channel: channelId,
      text: markdownToSlackMrkdwn(text),
      thread_ts: threadId,
    });
  }

  /**
   * Resolve the right client for a channel -- bot client for the default
   * channel (so the agent has its own identity), user client for everything else.
   */
  private clientFor(channelId: string): WebClient | null {
    if (channelId === this.defaultChannelId && this.botClient) {
      return this.botClient;
    }
    return this.client;
  }

  /**
   * Post a message and return the timestamp (for streaming support).
   * ONLY works in the default channel -- returns undefined for other channels
   * so the streaming responder falls through to send() -> draft manager.
   */
  async postMessage(
    channelId: string,
    text: string,
    threadId?: string,
  ): Promise<string | undefined> {
    if (channelId !== this.defaultChannelId) return undefined;

    const client = this.clientFor(channelId);
    if (!client) return undefined;
    const result = await client.chat.postMessage({
      channel: channelId,
      text: markdownToSlackMrkdwn(text),
      thread_ts: threadId,
    });
    return result.ts;
  }

  /**
   * Update an existing message (for streaming support).
   * Only works in the default channel.
   */
  async updateMessage(channelId: string, messageId: string, text: string): Promise<void> {
    if (channelId !== this.defaultChannelId) return;

    const client = this.clientFor(channelId);
    if (!client) return;
    await client.chat.update({
      channel: channelId,
      ts: messageId,
      text: markdownToSlackMrkdwn(text),
    });
  }

  /**
   * Delete a message.
   */
  async deleteMessage(channelId: string, messageId: string): Promise<void> {
    const client = this.clientFor(channelId);
    if (!client) return;
    await client.chat.delete({
      channel: channelId,
      ts: messageId,
    });
  }

  // ── Private helpers ──

  /**
   * Set baseline timestamps for all DM conversations so we don't
   * process historical messages on first start.
   *
   * Uses the current time as baseline instead of fetching the latest
   * message per channel -- avoids N conversations.history API calls
   * that easily hit Slack's Tier 3 rate limit (50 req/min).
   * Historical messages are handled by the ingestion pipeline.
   */
  private async initializeBaselines(): Promise<void> {
    if (!this.client) return;

    try {
      // Only fetch DM list on startup (cheap: 1 API call).
      // Member channels are fetched lazily on the first full scan.
      const dmChannels = await this.getDMChannels();
      const nowTs = `${(Date.now() / 1000).toFixed(6)}`;
      for (const channelId of dmChannels) {
        this.lastSeenTs.set(channelId, nowTs);
      }
      // Set baseline for default channel too
      if (this.defaultChannelId) {
        this.lastSeenTs.set(this.defaultChannelId, nowTs);
      }
      console.log(
        `[slack-polling] Baseline set for ${dmChannels.length} DMs` +
          (this.defaultChannelId ? ` + default channel` : "") +
          ` (using current time)`,
      );
    } catch (err) {
      console.warn("[slack-polling] Failed to initialize baselines:", err);
    }
  }

  /**
   * Get all DM channel IDs (im type). Cached and refreshed every 5 minutes.
   */
  private async getDMChannels(): Promise<string[]> {
    if (!this.client) return [];

    const now = Date.now();
    if (
      this.cachedDMChannels.length > 0 &&
      now - this.channelListLastFetched < SlackPollingAdapter.CHANNEL_REFRESH_INTERVAL_MS
    ) {
      return this.cachedDMChannels;
    }

    const channels: string[] = [];
    let cursor: string | undefined;

    do {
      const result = await this.client.conversations.list({
        types: "im",
        limit: 200,
        cursor,
        exclude_archived: true,
      });

      for (const ch of result.channels ?? []) {
        if (ch.id) channels.push(ch.id);
      }

      cursor = result.response_metadata?.next_cursor || undefined;
      if (cursor) await delay(SlackPollingAdapter.INTER_CALL_DELAY_MS);
    } while (cursor);

    this.cachedDMChannels = channels;
    this.channelListLastFetched = now;
    return channels;
  }

  /**
   * Get channels the user is a member of (public + private). Cached same as DMs.
   * Only fetches on the same refresh cycle as getDMChannels.
   */
  private async getMemberChannels(): Promise<string[]> {
    if (!this.client) return [];

    // Use the same cache timing as DM channels (refreshed together)
    const now = Date.now();
    if (
      this.cachedMemberChannels.length > 0 &&
      now - this.channelListLastFetched < SlackPollingAdapter.CHANNEL_REFRESH_INTERVAL_MS
    ) {
      return this.cachedMemberChannels;
    }

    const channels: string[] = [];
    let cursor: string | undefined;

    do {
      const result = await this.client.conversations.list({
        types: "public_channel,private_channel",
        limit: 200,
        cursor,
        exclude_archived: true,
      });

      for (const ch of result.channels ?? []) {
        if (ch.id && ch.is_member) channels.push(ch.id);
      }

      cursor = result.response_metadata?.next_cursor || undefined;
      if (cursor) await delay(SlackPollingAdapter.INTER_CALL_DELAY_MS);
    } while (cursor);

    this.cachedMemberChannels = channels;
    return channels;
  }

  /**
   * Main poll loop.
   *
   * Rate budget strategy (Tier 3: 50 req/min shared across all tokens):
   *   - EVERY cycle: poll the default channel only (1 API call)
   *   - EVERY cycle: poll active DMs only (channels that had recent messages)
   *   - FULL SCAN (every ~5h): poll ALL DMs to discover new conversations
   *   - Member channels (@mentions) are NOT polled -- too expensive.
   *     Use Socket Mode on the default workspace for real-time @mentions.
   *
   * Normal cycles: 1-3 API calls. Full scans: capped at 10 DMs/cycle.
   */
  private async poll(): Promise<void> {
    if (!this.running || !this.client || this.polling) return;
    this.polling = true;

    // Acquire the global mutex -- wait for any other adapter to finish first
    const release = await SlackPollingAdapter.acquireMutex();

    try {
      this.pollCount++;
      const isFullScan = this.pollCount % SlackPollingAdapter.FULL_SCAN_EVERY === 0;

      // 1. ALWAYS poll the default channel (primary chat channel, 1 API call)
      if (this.defaultChannelId) {
        const hadMessages = await this.pollChannel(this.defaultChannelId, "channel");
        if (hadMessages) {
          this.activeChannels.add(this.defaultChannelId);
        }
        await delay(SlackPollingAdapter.INTER_CALL_DELAY_MS);
      }

      // 2. Poll active DMs (only channels with recent messages)
      // On full scan: poll ALL DMs but cap to avoid rate limits
      const dmChannels = await this.getDMChannels();
      this.consecutiveErrors = 0;

      const dmsToPoll = isFullScan
        ? dmChannels.slice(0, 10) // Cap full scan to 10 DMs max
        : dmChannels.filter((ch) => this.activeChannels.has(ch));

      const callDelay = isFullScan
        ? SlackPollingAdapter.FULL_SCAN_DELAY_MS
        : SlackPollingAdapter.INTER_CALL_DELAY_MS;

      for (const channelId of dmsToPoll) {
        if (!this.running) break;
        const hadMessages = await this.pollChannel(channelId, "dm");
        if (hadMessages) {
          this.activeChannels.add(channelId);
        }
        await delay(callDelay);
      }

      if (isFullScan) {
        console.log(
          `[slack-polling] Full scan: ${dmsToPoll.length}/${dmChannels.length} DMs polled (team ${this.teamId})`,
        );
        // Decay active set -- full scan re-adds any with messages
        this.activeChannels.clear();
      }
    } catch (err: unknown) {
      const errorCode = (err as { data?: { error?: string } })?.data?.error;
      if (
        errorCode === "invalid_auth" ||
        errorCode === "token_revoked" ||
        errorCode === "account_inactive"
      ) {
        this.consecutiveErrors++;
        if (!this.authErrorFired && this.consecutiveErrors >= 3) {
          this.authErrorFired = true;
          console.error(`[slack-polling] Token expired for team ${this.teamId} — stopping polling`);
          this.onAuthError?.(this.teamId, this.teamName ?? this.teamId);
          await this.stop();
        }
      } else {
        this.consecutiveErrors++;
      }
    } finally {
      this.polling = false;
      release();
    }
  }

  /**
   * Acquire the global poll mutex. Returns a release function.
   * Ensures only one adapter instance polls Slack at a time.
   */
  private static async acquireMutex(): Promise<() => void> {
    let release: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Wait for current holder to finish, then become the holder
    await SlackPollingAdapter.pollMutex;
    SlackPollingAdapter.pollMutex = next;
    return release!;
  }

  /**
   * Poll a single channel for new messages since last check.
   * Returns true if new messages were found.
   */
  private async pollChannel(channelId: string, type: "dm" | "channel"): Promise<boolean> {
    if (!this.client || !this.userId) return false;

    try {
      const oldest = this.lastSeenTs.get(channelId);
      const history = await this.client.conversations.history({
        channel: channelId,
        limit: 10,
        oldest,
        inclusive: false, // Don't include the message at oldest ts
      });

      const messages = history.messages ?? [];
      if (messages.length === 0) return false;

      if (channelId === this.defaultChannelId) {
        console.log(`[slack-polling] Default channel has ${messages.length} new message(s)`);
      }

      // Update last seen to newest message
      const newestTs = messages[0]?.ts;
      if (newestTs) {
        this.lastSeenTs.set(channelId, newestTs);
      }

      // Process messages (oldest first)
      let hadRelevantMessages = false;
      const isDefaultChannel = channelId === this.defaultChannelId;
      for (const msg of messages.reverse()) {
        // Skip own messages -- except in the default channel where the
        // user chats directly with the agent via their own user token.
        // Check all known user IDs across workspaces (Slack Connect can surface
        // messages with a different workspace's user ID).
        if (!isDefaultChannel && msg.user && this.ownUserIds.has(msg.user)) continue;
        // Skip ALL bot messages to prevent echo loops. This catches:
        // - Our own bot responses (bot_id set when posting via bot token)
        // - Any other bot in the channel
        // - Messages with bot subtypes
        if ((msg as Record<string, unknown>).bot_id) continue;
        if (this.botUserId && msg.user === this.botUserId) continue;
        if (msg.subtype) continue;
        if (!msg.text || !msg.user || !msg.ts) continue;

        hadRelevantMessages = true;

        if (type === "dm" || isDefaultChannel) {
          await this.handleDM({
            text: msg.text,
            user: msg.user,
            ts: msg.ts,
            thread_ts: msg.thread_ts,
            channel: channelId,
          });
        } else if (msg.text.includes(`<@${this.userId}>`)) {
          await this.handleMention({
            text: msg.text,
            user: msg.user,
            ts: msg.ts,
            thread_ts: msg.thread_ts,
            channel: channelId,
          });
        }
      }

      return hadRelevantMessages;
    } catch (err) {
      // Log errors for the default channel (important), skip others silently
      if (channelId === this.defaultChannelId) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[slack-polling] Error polling default channel ${channelId}: ${msg}`);
      }
      return false;
    }
  }

  private async handleDM(e: {
    text: string;
    user: string;
    ts: string;
    thread_ts?: string;
    channel: string;
  }): Promise<void> {
    const senderName = await this.lookupUserName(e.user);
    const isDefaultChannel = e.channel === this.defaultChannelId;

    // Default channel: the user is chatting directly with the agent.
    // Pass the raw message -- no draft framing.
    // Other DMs: wrap with draft instructions so the agent drafts a
    // response on behalf of the user for approval.
    const content = isDefaultChannel
      ? e.text
      : [
          `[Slack DM from ${senderName}]`,
          "",
          e.text,
          "",
          "---",
          "Draft a response AS ME (the user). I will review and approve before it's sent.",
          "IMPORTANT: Do NOT send this yourself. Just draft the message content.",
          "Also suggest whether to reply in-thread or as a new message.",
        ].join("\n");

    // Cache incoming context so send() can enrich draft notifications.
    // Accumulate originalMessage for rapid sequential messages (message batching).
    if (!isDefaultChannel) {
      const prevCtx = this.lastIncomingContext.get(e.channel);
      const prevOriginal =
        prevCtx?.senderName === senderName ? (prevCtx.originalMessage as string) : "";
      this.lastIncomingContext.set(e.channel, {
        senderName,
        messageType: "dm",
        workspaceName: this.teamName ?? this.teamId,
        originalMessage: prevOriginal ? `${prevOriginal}\n${e.text}` : e.text,
      });
    }

    this.onMessage({
      id: randomUUID(),
      platform: this.platform,
      channelId: e.channel,
      userId: e.user,
      threadId: isDefaultChannel ? undefined : (e.thread_ts ?? e.ts),
      content,
      timestamp: new Date(),
      metadata: { senderName, messageType: isDefaultChannel ? "direct" : "dm" },
    });
  }

  private async handleMention(e: {
    text: string;
    user: string;
    ts: string;
    thread_ts?: string;
    channel: string;
  }): Promise<void> {
    const senderName = await this.lookupUserName(e.user);
    const channelName = await this.lookupChannelName(e.channel);
    const wrappedContent = [
      `[Slack @mention in #${channelName} from ${senderName}]`,
      "",
      e.text,
      "",
      "---",
      "Draft a response AS ME (the user). I will review and approve before it's sent.",
      "IMPORTANT: Do NOT send this yourself. Just draft the message content.",
      "Also suggest whether to reply in-thread or as a new message.",
    ].join("\n");

    // Cache incoming context so send() can enrich draft notifications.
    // Accumulate originalMessage for rapid sequential messages (message batching).
    const prevMentionCtx = this.lastIncomingContext.get(e.channel);
    const prevMentionOriginal =
      prevMentionCtx?.senderName === senderName ? (prevMentionCtx.originalMessage as string) : "";
    this.lastIncomingContext.set(e.channel, {
      senderName,
      channelName,
      messageType: "mention",
      workspaceName: this.teamName ?? this.teamId,
      originalMessage: prevMentionOriginal ? `${prevMentionOriginal}\n${e.text}` : e.text,
    });

    this.onMessage({
      id: randomUUID(),
      platform: this.platform,
      channelId: e.channel,
      userId: e.user,
      threadId: e.thread_ts ?? e.ts,
      content: wrappedContent,
      timestamp: new Date(),
      metadata: { senderName, channelName, messageType: "mention" },
    });
  }

  private async lookupUserName(userId: string): Promise<string> {
    const cached = this.userNameCache.get(userId);
    if (cached) return cached;

    // Try main client, then bot client (bot may have users:read scope when user token doesn't)
    for (const [label, client] of [
      ["user", this.client],
      ["bot", this.botClient],
    ] as const) {
      if (!client) continue;
      try {
        const result = await (client as WebClient).users.info({ user: userId });
        const name =
          result.user?.profile?.display_name ||
          result.user?.real_name ||
          result.user?.name ||
          userId;
        if (name !== userId) {
          this.userNameCache.set(userId, name);
          return name;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[slack-polling] ${label} client failed to resolve user ${userId}: ${msg}`);
      }
    }
    return userId;
  }

  private async lookupChannelName(channelId: string): Promise<string> {
    const cached = this.channelNameCache.get(channelId);
    if (cached) return cached;

    try {
      const result = await this.client!.conversations.info({ channel: channelId });
      const name = result.channel?.name ?? channelId;
      this.channelNameCache.set(channelId, name);
      return name;
    } catch {
      return channelId;
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
