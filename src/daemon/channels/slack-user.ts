/**
 * Slack User Mode adapter.
 *
 * Listens to DMs and @mentions directed at the authenticated user,
 * generates agent responses, and queues them as drafts for approval.
 * On approval, messages are sent via the user's xoxp- token so they
 * appear as if the user typed them.
 *
 * Supports multiple workspaces — each adapter instance is constructed
 * with explicit tokens and a team ID.
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
  teamId: string;
  onMessage: (msg: IncomingMessage) => void;
  draftManager: DraftManager;
}

export class SlackUserAdapter implements ChannelAdapter {
  private readonly teamId: string;
  private readonly userToken: string;
  private readonly appToken: string;
  private app: InstanceType<typeof App> | null = null;
  private userClient: WebClient | null = null;
  private userId: string | null = null;
  private onMessage: (msg: IncomingMessage) => void;
  private draftManager: DraftManager;

  // Cache for user/channel name lookups
  private userNameCache = new Map<string, string>();
  private channelNameCache = new Map<string, string>();

  get platform(): string {
    return `slack-user:${this.teamId}`;
  }

  constructor(options: SlackUserAdapterOptions) {
    this.userToken = options.userToken;
    this.appToken = options.appToken;
    this.teamId = options.teamId;
    this.onMessage = options.onMessage;
    this.draftManager = options.draftManager;
  }

  async start(): Promise<void> {
    // Bolt app using the user token for event subscriptions
    this.app = new App({ token: this.userToken, appToken: this.appToken, socketMode: true });
    this.userClient = new WebClient(this.userToken);

    // Resolve own user ID
    const auth = await this.userClient.auth.test();
    this.userId = auth.user_id ?? null;
    if (!this.userId) {
      throw new Error(`Could not resolve user ID from token for team ${this.teamId}`);
    }

    // Listen to all message events
    this.app.event("message", async ({ event }) => {
      const e = event as {
        channel_type?: string;
        text?: string;
        user?: string;
        ts: string;
        thread_ts?: string;
        channel: string;
        subtype?: string;
      };

      // Skip subtypes (edits, joins, etc.) and messages without text/user
      if (e.subtype || !e.text || !e.user) return;
      // Skip own messages
      if (e.user === this.userId) return;

      if (e.channel_type === "im") {
        // Direct message to the user
        await this.handleDM(e);
      } else if (e.channel_type === "channel" || e.channel_type === "group") {
        // Channel/group message — check for @mention of the user
        if (e.text.includes(`<@${this.userId}>`)) {
          await this.handleMention(e);
        }
      }
    });

    await this.app.start();
    console.log(`[slack-user-adapter] Running (user: ${this.userId}, team: ${this.teamId})`);
  }

  async stop(): Promise<void> {
    if (this.app) {
      await this.app.stop();
      this.app = null;
    }
    this.userClient = null;
  }

  /**
   * Intercept outgoing messages and create drafts instead of sending.
   */
  async send(message: OutgoingMessage): Promise<void> {
    if (!this.userId) return;

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

  // ── Private helpers ──

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
    if (!cleanText) return;

    const wrappedContent = [
      `[Slack mention from ${senderName} in #${channelName}]`,
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
