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
import { markdownToSlackMrkdwn } from "./slack-mrkdwn.ts";

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
  private teamName: string | null = null;
  private onMessage: (msg: IncomingMessage) => void;
  private draftManager: DraftManager;

  // Default channel -- the user's direct chat channel with the agent
  private defaultChannelId: string | null = null;

  // Cache for user/channel name lookups
  private userNameCache = new Map<string, string>();
  private channelNameCache = new Map<string, string>();

  // Cache last incoming message context per channel so send() can enrich drafts
  private lastIncomingContext = new Map<string, Record<string, unknown>>();

  // All known user IDs for the owner across workspaces (loaded once on start)
  private ownUserIds = new Set<string>();

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
    this.teamName = (auth.team as string) ?? null;
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

    // Load all known user IDs for the owner across workspaces.
    // This catches own messages even when Slack Connect surfaces them with
    // a different workspace's user ID.
    if (this.userId) this.ownUserIds.add(this.userId);
    if (this.botUserId) this.ownUserIds.add(this.botUserId);
    try {
      const { listIntegrationsByPrefix } = await import("../../db/integrations.ts");
      const workspaces = await listIntegrationsByPrefix("slack-ws:");
      for (const ws of workspaces) {
        const uid = (ws.metadata as Record<string, unknown>)?.user_id;
        if (typeof uid === "string") this.ownUserIds.add(uid);
      }
      console.log(`[slack-user-adapter] Own user IDs: ${[...this.ownUserIds].join(", ")}`);
    } catch {
      // integrations not available
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
      if (e.user === this.userId && !isDefaultChannel) {
        return;
      }

      // Also skip messages from any of our known workspace user IDs
      if (!isDefaultChannel && this.isOwnUserId(e.user)) {
        return;
      }

      console.log(
        `[slack-user-adapter] Processing message: user=${e.user}, channel=${e.channel}, type=${e.channel_type}, isDefault=${isDefaultChannel}, myUserId=${this.userId}`,
      );

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

    // Register draft approval/rejection action handlers for the default channel.
    // These handle button clicks on draft notifications posted by the gateway.
    // Must be registered here because SlackAdapter (bot mode) may not be running.
    this.app.action("approve_draft", async ({ action, ack, respond }) => {
      await ack();
      const draftId = (action as { value?: string }).value;
      if (!draftId) return;
      const result = await this.draftManager.approve(draftId);
      await respond({
        replace_original: true,
        text: result.success
          ? `:white_check_mark: Draft ${draftId.slice(0, 8)} approved and sent`
          : `:x: Failed: ${result.error}`,
      });
    });

    this.app.action("reject_draft", async ({ action, ack, respond }) => {
      await ack();
      const draftId = (action as { value?: string }).value;
      if (!draftId) return;
      const result = await this.draftManager.reject(draftId);
      await respond({
        replace_original: true,
        text: result.success
          ? `:no_entry_sign: Draft ${draftId.slice(0, 8)} declined`
          : `:x: Failed: ${result.error}`,
      });
    });

    // Edit draft: open a modal with the draft content for editing
    this.app.action("edit_draft", async ({ action, ack, body }) => {
      await ack();
      const draftId = (action as { value?: string }).value;
      if (!draftId) return;

      // Load draft content from DB
      const { getDraft } = await import("../../db/drafts.ts");
      const draft = await getDraft(draftId);
      if (!draft) return;

      const client = this.botClient ?? this.userClient;
      if (!client) return;

      await client.views.open({
        trigger_id: (body as { trigger_id?: string }).trigger_id!,
        view: {
          type: "modal",
          callback_id: "edit_draft_submit",
          private_metadata: draftId,
          title: { type: "plain_text", text: "Edit Draft" },
          submit: { type: "plain_text", text: "Send" },
          close: { type: "plain_text", text: "Cancel" },
          blocks: [
            {
              type: "input",
              block_id: "draft_content",
              label: { type: "plain_text", text: "Message" },
              element: {
                type: "plain_text_input",
                action_id: "content",
                multiline: true,
                initial_value: draft.content,
              },
            },
          ],
        },
      });
    });

    // Handle modal submission: approve the draft with edited content
    this.app.view("edit_draft_submit", async ({ ack, view }) => {
      await ack();
      const draftId = view.private_metadata;
      const editedContent = view.state.values.draft_content?.content?.value ?? "";

      if (!draftId || !editedContent) return;

      const result = await this.draftManager.approveWithEdit(draftId, editedContent);

      // Post confirmation to default channel
      if (this.defaultChannelId) {
        const client = this.botClient ?? this.userClient;
        if (client) {
          await client.chat.postMessage({
            channel: this.defaultChannelId,
            text: result.success
              ? `:white_check_mark: Draft ${draftId.slice(0, 8)} edited and sent`
              : `:x: Failed to send edited draft: ${result.error}`,
          });
        }
      }
    });

    await this.app.start();
    console.log(
      `[slack-user-adapter] Running via Socket Mode (user: ${this.userId}, bot: ${this.botUserId}, team: ${this.teamId}, defaultChannel: ${this.defaultChannelId})`,
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
   * Send a message as the authenticated user (called after approval).
   */
  async sendAsUser(channelId: string, text: string, threadId?: string): Promise<void> {
    const client = new WebClient(this.userToken);
    await client.chat.postMessage({
      channel: channelId,
      text: markdownToSlackMrkdwn(text),
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
      text: markdownToSlackMrkdwn(text),
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
   * ONLY works in the default channel -- returns undefined for other channels
   * so the streaming responder falls through to send() -> draft manager.
   * This prevents the agent from posting directly in DMs without approval.
   */
  async postMessage(
    channelId: string,
    text: string,
    threadId?: string,
  ): Promise<string | undefined> {
    // Non-default channels: block streaming, force through draft approval
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
   * Only works in the default channel (matches postMessage guard).
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
    if (channelId !== this.defaultChannelId) return;

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
      "Draft a response AS ME (the user). I will review and approve before it's sent.",
      "IMPORTANT: Do NOT send this yourself. Just draft the message content.",
      "Also suggest whether to reply in-thread or as a new message.",
    ].join("\n");

    // Cache incoming context so send() can enrich draft notifications.
    // Accumulate originalMessage for rapid sequential messages (message batching).
    const prevCtx = this.lastIncomingContext.get(e.channel);
    const prevOriginal =
      prevCtx?.senderName === senderName ? (prevCtx.originalMessage as string) : "";
    this.lastIncomingContext.set(e.channel, {
      senderName,
      messageType: "dm",
      workspaceName: this.teamName ?? this.teamId,
      originalMessage: prevOriginal ? `${prevOriginal}\n${e.text!}` : e.text!,
    });

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
      "Draft a response AS ME (the user). I will review and approve before it's sent.",
      "IMPORTANT: Do NOT send this yourself. Just draft the message content.",
      "Also suggest whether to reply in-thread or as a new message in the channel.",
    ].join("\n");

    // Cache incoming context so send() can enrich draft notifications.
    // Accumulate originalMessage for rapid sequential messages (message batching).
    const prevCtx = this.lastIncomingContext.get(e.channel);
    const prevOriginal =
      prevCtx?.senderName === senderName ? (prevCtx.originalMessage as string) : "";
    this.lastIncomingContext.set(e.channel, {
      senderName,
      channelName,
      messageType: "mention",
      workspaceName: this.teamName ?? this.teamId,
      originalMessage: prevOriginal ? `${prevOriginal}\n${cleanText}` : cleanText,
    });

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

  /** Check if a user ID belongs to the owner (across all workspaces). */
  private isOwnUserId(userId: string): boolean {
    return this.ownUserIds.has(userId);
  }

  private async lookupUserName(userId: string): Promise<string> {
    const cached = this.userNameCache.get(userId);
    if (cached) return cached;

    // Try bot client first (more likely to have users:read scope), then user client
    for (const [label, client] of [
      ["bot", this.botClient],
      ["user", this.userClient],
    ] as const) {
      if (!client) continue;
      try {
        const result = await (client as WebClient).users.info({ user: userId });
        const name = result.user?.real_name ?? result.user?.name ?? userId;
        if (name !== userId) {
          this.userNameCache.set(userId, name);
          return name;
        }
      } catch {
        // user_not_found is expected for Slack Connect / cross-workspace users
      }
    }

    // Fallback: try other workspace tokens (for Slack Connect / cross-workspace users)
    const name = await this.lookupUserCrossWorkspace(userId);
    if (name) {
      this.userNameCache.set(userId, name);
      return name;
    }

    return userId;
  }

  /**
   * Try to resolve a user name using tokens from other workspaces.
   * Needed for Slack Connect users whose IDs belong to a different workspace.
   */
  private async lookupUserCrossWorkspace(userId: string): Promise<string | null> {
    try {
      const { listIntegrationsByPrefix } = await import("../../db/integrations.ts");
      const workspaces = await listIntegrationsByPrefix("slack-ws:");
      for (const ws of workspaces) {
        // Skip our own workspace (already tried)
        if (ws.name === `slack-ws:${this.teamId}`) continue;
        const token = ws.secrets?.access_token;
        if (!token) continue;
        try {
          const client = new WebClient(token as string);
          const result = await client.users.info({ user: userId });
          const name = result.user?.real_name ?? result.user?.name ?? null;
          if (name) return name;
        } catch {
          // not found in this workspace either
        }
      }
    } catch {
      // integrations not available
    }
    return null;
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
