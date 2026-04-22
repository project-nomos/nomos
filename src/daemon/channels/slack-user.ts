/**
 * Slack User Mode adapter (Socket Mode -- real-time).
 *
 * Listens to DMs, @mentions, and the default channel via Slack's Socket
 * Mode WebSocket connection. Events arrive in real-time (sub-second).
 *
 * Behavior varies by context:
 * - Default channel: own messages processed, agent responds as bot, no drafts
 * - DMs from others: agent drafts response for approval, sends as user
 * - @mentions in channels: same as DMs (draft + approve)
 */

import SlackBolt from "@slack/bolt";
import { WebClient } from "@slack/web-api";
import type { ChannelAdapter, IncomingMessage, OutgoingMessage } from "../types.ts";
import type { DraftManager } from "../draft-manager.ts";
import { randomUUID } from "node:crypto";

// CJS/ESM interop (same pattern as slack.ts)
const slackBoltModule = SlackBolt as typeof import("@slack/bolt") & {
  default?: typeof import("@slack/bolt");
};
const slackBolt =
  (slackBoltModule.App ? slackBoltModule : slackBoltModule.default) ?? slackBoltModule;
const { App } = slackBolt;

export interface SlackUserAdapterOptions {
  userToken: string;
  appToken: string;
  botToken?: string;
  teamId: string;
  onMessage: (msg: IncomingMessage) => void;
  draftManager: DraftManager;
}

export class SlackUserAdapter implements ChannelAdapter {
  private readonly teamId: string;
  private readonly userToken: string;
  private readonly appToken: string;
  private readonly botTokenStr: string | undefined;
  private app: InstanceType<typeof App> | null = null;
  private userClient: WebClient | null = null;
  private botClient: WebClient | null = null;
  private userId: string | null = null;
  private botUserId: string | null = null;
  private onMessage: (msg: IncomingMessage) => void;
  private draftManager: DraftManager;

  // Default channel -- the user's direct chat channel with the agent
  private defaultChannelId: string | null = null;

  // Cache for user/channel name lookups
  private userNameCache = new Map<string, string>();
  private channelNameCache = new Map<string, string>();

  get platform(): string {
    return `slack-user:${this.teamId}`;
  }

  constructor(options: SlackUserAdapterOptions) {
    this.userToken = options.userToken;
    this.appToken = options.appToken;
    this.botTokenStr = options.botToken;
    this.teamId = options.teamId;
    this.onMessage = options.onMessage;
    this.draftManager = options.draftManager;

    // Bot client for posting agent responses with distinct identity
    if (options.botToken) {
      this.botClient = new WebClient(options.botToken);
    }
  }

  async start(): Promise<void> {
    // Bolt requires the BOT token for Socket Mode event delivery.
    // User tokens don't receive Socket Mode events reliably.
    // The user token is kept separately for API calls (posting as user).
    const boltToken = this.botTokenStr ?? this.userToken;
    this.app = new App({ token: boltToken, appToken: this.appToken, socketMode: true });
    this.userClient = new WebClient(this.userToken);

    // Resolve own user ID (from user token)
    const auth = await this.userClient.auth.test();
    this.userId = auth.user_id ?? null;
    if (!this.userId) {
      throw new Error(`Could not resolve user ID from token for team ${this.teamId}`);
    }

    // Resolve bot user ID (for echo loop prevention)
    if (this.botClient) {
      try {
        const botAuth = await this.botClient.auth.test();
        this.botUserId = (botAuth.user_id as string) ?? null;
        console.log(`[slack-user-adapter] Bot identity loaded (${this.botUserId})`);
      } catch {
        console.warn(`[slack-user-adapter] Bot token auth failed -- agent will post as user`);
        this.botClient = null;
      }
    }

    // Load default notification channel
    try {
      const { getNotificationDefault } = await import("../../db/notification-defaults.ts");
      const nd = await getNotificationDefault();
      if (nd && nd.platform === this.platform) {
        this.defaultChannelId = nd.channelId;
        console.log(
          `[slack-user-adapter] Default channel: ${nd.channelId} (${nd.label ?? "unlabeled"})`,
        );
      }
    } catch {
      // notification defaults not available
    }

    // Listen to all message events
    this.app.event("message", async ({ event }) => {
      const e = event as {
        channel_type?: string;
        text?: string;
        user?: string;
        bot_id?: string;
        ts: string;
        thread_ts?: string;
        channel: string;
        subtype?: string;
      };

      // Skip subtypes (edits, joins, etc.) and messages without text/user
      if (e.subtype || !e.text || !e.user) return;

      // Skip ALL bot messages (prevents echo loops)
      if (e.bot_id) return;
      if (this.botUserId && e.user === this.botUserId) return;

      const isDefaultChannel = e.channel === this.defaultChannelId;

      // Skip own messages -- except in the default channel
      if (e.user === this.userId && !isDefaultChannel) return;

      if (isDefaultChannel) {
        // Default channel: raw message, no draft framing
        await this.handleDefaultChannel(e);
      } else if (e.channel_type === "im") {
        await this.handleDM(e);
      } else if (e.channel_type === "channel" || e.channel_type === "group") {
        if (e.text.includes(`<@${this.userId}>`)) {
          await this.handleMention(e);
        }
      }
    });

    await this.app.start();
    console.log(
      `[slack-user-adapter] Running via Socket Mode (user: ${this.userId}, team: ${this.teamId})`,
    );
  }

  async stop(): Promise<void> {
    if (this.app) {
      await this.app.stop();
      this.app = null;
    }
    this.userClient = null;
  }

  /**
   * Route outgoing messages based on context.
   * Default channel: respond directly as bot.
   * Everything else: create draft for approval.
   */
  async send(message: OutgoingMessage): Promise<void> {
    if (!this.userId) return;

    if (message.channelId === this.defaultChannelId) {
      await this.sendAsAgent(message.channelId, message.content, message.threadId);
      return;
    }

    const context: Record<string, unknown> = {
      channelId: message.channelId,
      threadId: message.threadId,
    };

    await this.draftManager.createDraft(message, this.userId, context);
  }

  /**
   * Send a message as the authenticated user (called after approval).
   */
  async sendAsUser(channelId: string, text: string, threadId?: string): Promise<void> {
    const client = new WebClient(this.userToken);
    await client.chat.postMessage({
      channel: channelId,
      text,
      thread_ts: threadId,
    });
  }

  /**
   * Send as the bot identity (for default channel).
   * Falls back to user token if bot not configured.
   */
  async sendAsAgent(channelId: string, text: string, threadId?: string): Promise<void> {
    const client = this.botClient ?? this.userClient;
    if (!client) return;
    await client.chat.postMessage({
      channel: channelId,
      text,
      thread_ts: threadId,
    });
  }

  /**
   * Resolve the right client for a channel.
   */
  private clientFor(channelId: string): WebClient | null {
    if (channelId === this.defaultChannelId && this.botClient) {
      return this.botClient;
    }
    return this.userClient;
  }

  /**
   * Post a message and return the timestamp (for streaming support).
   */
  async postMessage(
    channelId: string,
    text: string,
    threadId?: string,
  ): Promise<string | undefined> {
    const client = this.clientFor(channelId);
    if (!client) return undefined;
    const result = await client.chat.postMessage({
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
    const client = this.clientFor(channelId);
    if (!client) return;
    await client.chat.update({
      channel: channelId,
      ts: messageId,
      text,
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

  private async handleDefaultChannel(e: {
    text?: string;
    user?: string;
    ts: string;
    thread_ts?: string;
    channel: string;
  }): Promise<void> {
    this.onMessage({
      id: randomUUID(),
      platform: this.platform,
      channelId: e.channel,
      userId: e.user!,
      content: e.text!,
      timestamp: new Date(),
      metadata: { messageType: "direct" },
    });
  }

  private async handleDM(e: {
    text?: string;
    user?: string;
    ts: string;
    thread_ts?: string;
    channel: string;
  }): Promise<void> {
    const senderName = await this.lookupUserName(e.user!);
    const wrappedContent = [
      `[Slack DM from ${senderName}]`,
      "",
      e.text!,
      "",
      "---",
      "Draft a response AS ME (the user). I will approve it before it's sent.",
    ].join("\n");

    this.onMessage({
      id: randomUUID(),
      platform: this.platform,
      channelId: e.channel,
      userId: e.user!,
      threadId: e.thread_ts ?? e.ts,
      content: wrappedContent,
      timestamp: new Date(),
      metadata: { senderName, messageType: "dm" },
    });
  }

  private async handleMention(e: {
    text?: string;
    user?: string;
    ts: string;
    thread_ts?: string;
    channel: string;
  }): Promise<void> {
    const senderName = await this.lookupUserName(e.user!);
    const channelName = await this.lookupChannelName(e.channel);
    const cleanText = e.text!.replace(new RegExp(`<@${this.userId}>`, "g"), "").trim();

    const wrappedContent = [
      `[Slack @mention in #${channelName} from ${senderName}]`,
      "",
      cleanText,
      "",
      "---",
      "Draft a response AS ME (the user). I will approve it before it's sent.",
    ].join("\n");

    this.onMessage({
      id: randomUUID(),
      platform: this.platform,
      channelId: e.channel,
      userId: e.user!,
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
      const result = await this.userClient!.users.info({ user: userId });
      const name = result.user?.real_name ?? result.user?.name ?? userId;
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
      const result = await this.userClient!.conversations.info({ channel: channelId });
      const name = result.channel?.name ?? channelId;
      this.channelNameCache.set(channelId, name);
      return name;
    } catch {
      return channelId;
    }
  }
}
