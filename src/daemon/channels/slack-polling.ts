/**
 * Slack Polling adapter.
 *
 * Uses xoxc- session tokens (extracted via browser login) to poll for
 * new DMs and @mentions. No Slack app or Socket Mode required — just
 * a browser session token + cookie.
 *
 * Also works with xoxp- tokens (cookie not needed in that case).
 */

import { WebClient } from "@slack/web-api";
import type { ChannelAdapter, IncomingMessage, OutgoingMessage } from "../types.ts";
import type { DraftManager } from "../draft-manager.ts";
import { randomUUID } from "node:crypto";

export interface SlackPollingAdapterOptions {
  token: string;
  cookie?: string;
  teamId: string;
  pollIntervalMs?: number;
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
  private authErrorFired = false;
  private consecutiveErrors = 0;

  // Track last seen timestamp per channel to fetch only new messages
  private lastSeenTs = new Map<string, string>();

  // Cache for user/channel name lookups
  private userNameCache = new Map<string, string>();
  private channelNameCache = new Map<string, string>();

  get platform(): string {
    return `slack-user:${this.teamId}`;
  }

  constructor(options: SlackPollingAdapterOptions) {
    this.token = options.token;
    this.cookie = options.cookie;
    this.teamId = options.teamId;
    this.pollIntervalMs = options.pollIntervalMs ?? 5000;
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

    // Initial poll to set baselines (don't process old messages)
    await this.initializeBaselines();

    // Start polling
    this.pollTimer = setInterval(() => {
      this.poll().catch((err) => {
        console.error(`[slack-polling] Poll error (team ${this.teamId}):`, err);
      });
    }, this.pollIntervalMs);
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

    const context: Record<string, unknown> = {
      channelId: message.channelId,
      threadId: message.threadId,
    };

    await this.draftManager.createDraft(message, this.userId, context);
  }

  /**
   * Send a message as the authenticated user (called after draft approval).
   */
  async sendAsUser(channelId: string, text: string, threadId?: string): Promise<void> {
    if (!this.client) return;
    await this.client.chat.postMessage({
      channel: channelId,
      text,
      thread_ts: threadId,
    });
  }

  /**
   * Post a message and return the timestamp (for streaming support).
   */
  async postMessage(
    channelId: string,
    text: string,
    threadId?: string,
  ): Promise<string | undefined> {
    if (!this.client) return undefined;
    const result = await this.client.chat.postMessage({
      channel: channelId,
      text,
      thread_ts: threadId,
    });
    return result.ts;
  }

  /**
   * Update an existing message (for streaming support).
   */
  async updateMessage(channelId: string, messageId: string, text: string): Promise<void> {
    if (!this.client) return;
    await this.client.chat.update({
      channel: channelId,
      ts: messageId,
      text,
    });
  }

  /**
   * Delete a message.
   */
  async deleteMessage(channelId: string, messageId: string): Promise<void> {
    if (!this.client) return;
    await this.client.chat.delete({
      channel: channelId,
      ts: messageId,
    });
  }

  // ── Private helpers ──

  /**
   * Set baseline timestamps for all DM conversations so we don't
   * process historical messages on first start.
   */
  private async initializeBaselines(): Promise<void> {
    if (!this.client) return;

    try {
      const dmChannels = await this.getDMChannels();
      for (const channelId of dmChannels) {
        try {
          const history = await this.client.conversations.history({
            channel: channelId,
            limit: 1,
          });
          const latest = history.messages?.[0];
          if (latest?.ts) {
            this.lastSeenTs.set(channelId, latest.ts);
          }
        } catch {
          // Channel might be inaccessible — skip
        }
      }
      console.log(`[slack-polling] Baseline set for ${this.lastSeenTs.size} DM channels`);
    } catch (err) {
      console.warn("[slack-polling] Failed to initialize baselines:", err);
    }
  }

  /**
   * Get all DM channel IDs (im type).
   */
  private async getDMChannels(): Promise<string[]> {
    if (!this.client) return [];

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
    } while (cursor);

    return channels;
  }

  /**
   * Main poll loop: check DMs and channel mentions for new messages.
   */
  private async poll(): Promise<void> {
    if (!this.running || !this.client) return;

    try {
      // Poll DMs
      const dmChannels = await this.getDMChannels();
      this.consecutiveErrors = 0; // Reset on success
      for (const channelId of dmChannels) {
        await this.pollChannel(channelId, "dm");
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
    }
  }

  /**
   * Poll a single channel for new messages since last check.
   */
  private async pollChannel(channelId: string, type: "dm" | "channel"): Promise<void> {
    if (!this.client || !this.userId) return;

    try {
      const oldest = this.lastSeenTs.get(channelId);
      const history = await this.client.conversations.history({
        channel: channelId,
        limit: 10,
        oldest,
        inclusive: false, // Don't include the message at oldest ts
      });

      const messages = history.messages ?? [];
      if (messages.length === 0) return;

      // Update last seen to newest message
      const newestTs = messages[0]?.ts;
      if (newestTs) {
        this.lastSeenTs.set(channelId, newestTs);
      }

      // Process messages (oldest first)
      for (const msg of messages.reverse()) {
        // Skip own messages
        if (msg.user === this.userId) continue;
        // Skip bot messages, system messages
        if (msg.subtype) continue;
        if (!msg.text || !msg.user || !msg.ts) continue;

        if (type === "dm") {
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
    } catch {
      // Channel might have become inaccessible — skip silently
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
    const wrappedContent = [
      `[Slack DM from ${senderName}]`,
      "",
      e.text,
      "",
      "---",
      "Draft a response AS ME (the user). I will approve it before it's sent.",
    ].join("\n");

    this.onMessage({
      id: randomUUID(),
      platform: this.platform,
      channelId: e.channel,
      userId: e.user,
      threadId: e.thread_ts ?? e.ts,
      content: wrappedContent,
      timestamp: new Date(),
      metadata: { senderName, messageType: "dm" },
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
      "Draft a response AS ME (the user). I will approve it before it's sent.",
    ].join("\n");

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

    try {
      const result = await this.client!.users.info({ user: userId });
      const name =
        result.user?.profile?.display_name || result.user?.real_name || result.user?.name || userId;
      this.userNameCache.set(userId, name);
      return name;
    } catch {
      return userId;
    }
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
