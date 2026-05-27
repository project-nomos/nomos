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
import { createLogger } from "../../lib/logger.ts";

const log = createLogger("slack-user");

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
  // Optional elicitation manager — wired in by gateway after construction.
  // Used by the ask_user button action handler to resolve pending requests.
  private elicitationManager?: import("../elicitation-manager.ts").ElicitationManager;

  /** Inject the elicitation manager. Called by gateway after adapter creation. */
  setElicitationManager(mgr: import("../elicitation-manager.ts").ElicitationManager): void {
    this.elicitationManager = mgr;
  }

  // Optional auth-error sink. Gateway pipes this into the WS/gRPC
  // broadcast stream so the Settings UI can render a banner explaining
  // *why* messages aren't flowing.
  private onAuthError?: (
    teamId: string,
    teamName: string,
    info?: { kind: "user" | "bot"; reason: string },
  ) => void;

  /** Wire the auth-error sink. Called by gateway right after construction. */
  setOnAuthError(
    cb: (teamId: string, teamName: string, info?: { kind: "user" | "bot"; reason: string }) => void,
  ): void {
    this.onAuthError = cb;
  }

  // Default channel -- the user's direct chat channel with the agent
  private defaultChannelId: string | null = null;

  // Cache for user/channel name lookups
  private userNameCache = new Map<string, string>();
  private channelNameCache = new Map<string, string>();

  // Cache last incoming message context per channel so send() can enrich drafts
  private lastIncomingContext = new Map<string, Record<string, unknown>>();

  // All known user IDs for the owner across workspaces (loaded once on start)
  private ownUserIds = new Set<string>();
  // Owner email derived from `users.info(self)` — used to recognize foreign
  // workspace user IDs surfaced by Slack Connect DMs.
  private ownerEmail: string | null = null;

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
    this.userClient = new WebClient(this.userToken);

    // Resolve own user ID (from user token)
    const auth = await this.userClient.auth.test();
    this.userId = auth.user_id ?? null;
    this.teamName = (auth.team as string) ?? null;
    if (!this.userId) {
      throw new Error(`Could not resolve user ID from token for team ${this.teamId}`);
    }

    // CRITICAL: verify the user token actually belongs to this workspace.
    // OAuth/reconnect flows have historically written a token from the
    // wrong workspace into a per-workspace row; the symptom is later
    // `channel_not_found` errors when posting, because the token's real
    // team can't see channels from the team we *think* it's for.
    const tokenTeamId = (auth as { team_id?: string }).team_id;
    if (tokenTeamId && tokenTeamId !== this.teamId) {
      log.error(
        { expectedTeamId: this.teamId, tokenTeamId, tokenUserId: this.userId },
        "Slack user token belongs to a different workspace than its DB row claims. " +
          "Cause: a previous OAuth/reconnect wrote the wrong access_token here. " +
          "Fix: in Settings → Slack, Remove this workspace and Reconnect — the OAuth " +
          "callback will write the correct token. Until fixed, every post to channels " +
          "in this workspace will 404 with channel_not_found.",
      );
      this.onAuthError?.(this.teamId, this.teamName ?? this.teamId, {
        kind: "user",
        reason: `Slack user token for ${this.teamName ?? this.teamId} belongs to a different workspace (token's team: ${tokenTeamId}). Remove + Reconnect in Settings → Slack.`,
      });
    }

    // Validate the bot token BEFORE handing it to Bolt. Constructing
    // `new App({ token: <bad-bot-token>, ... })` triggers an internal
    // auth.test that fires unhandled rejections (e.g. account_inactive)
    // even if we later catch the bot client's own auth check. By
    // validating up front we can drop a bad bot token and fall back to
    // the user token for Bolt's Socket Mode connection.
    let validatedBotToken: string | undefined;
    if (this.botClient && this.botTokenStr) {
      try {
        const botAuth = await this.botClient.auth.test();
        this.botUserId = (botAuth.user_id as string) ?? null;
        validatedBotToken = this.botTokenStr;
        log.info(`Bot identity loaded (${this.botUserId})`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // `account_inactive` means the entire Slack app has been disabled
        // — usually by the workspace admin or via the Slack app dashboard.
        // No token refresh fixes it; the user has to reinstall the app or
        // re-enable it at api.slack.com/apps. Socket Mode events will not
        // arrive while the bot is dead, so chat with the agent stops
        // working too — surface a loud, actionable diagnostic.
        const isInactive = /account_inactive/i.test(message);
        if (isInactive) {
          log.error(
            { teamId: this.teamId, message },
            "Slack bot is INACTIVE — Socket Mode events will not arrive; the agent " +
              "won't receive any messages. Fix: reinstall the Nomos Slack app at " +
              "https://api.slack.com/apps (or have a workspace admin re-enable it). " +
              "After reinstalling, click 'Reconnect' in Settings → Integrations → Slack.",
          );
          // Surface to UI so the user sees this even if they aren't
          // tailing the daemon log. Highest-priority because Socket
          // Mode for this workspace = dead chat with the agent.
          this.onAuthError?.(this.teamId, this.teamName ?? this.teamId, {
            kind: "bot",
            reason: `Slack bot is inactive in ${this.teamName ?? this.teamId} — agent can't receive messages here. Install/re-enable the Nomos app at api.slack.com/apps, then click Reconnect.`,
          });
        } else {
          log.warn(`Bot token auth failed (${message}) -- agent will post as user`);
        }
        this.botClient = null;
      }
    }

    // Bolt requires the BOT token for Socket Mode event delivery when
    // available; user tokens don't receive Socket Mode events reliably.
    // If the bot token was rejected, fall back to the user token (Socket
    // Mode events may be incomplete, but DMs still flow).
    const boltToken = validatedBotToken ?? this.userToken;
    this.app = new App({ token: boltToken, appToken: this.appToken, socketMode: true });

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
      log.info(`Own user IDs: ${[...this.ownUserIds].join(", ")}`);
    } catch {
      // integrations not available
    }

    // Resolve the owner's email so we can match cross-workspace user IDs.
    // Slack Connect DMs surface messages with the sender's home-workspace
    // user ID, which won't appear in our static ownUserIds set; comparing
    // by email lets us recognize them dynamically.
    if (this.userId) {
      try {
        const info = await this.userClient.users.info({ user: this.userId });
        const email = info.user?.profile?.email;
        if (typeof email === "string" && email) {
          this.ownerEmail = email.toLowerCase();
        }
      } catch {
        // users.info may lack scope on the user token; non-fatal.
      }
    }

    // Load default notification channel
    try {
      const { getNotificationDefault } = await import("../../db/notification-defaults.ts");
      const nd = await getNotificationDefault();
      if (nd && nd.platform === this.platform) {
        this.defaultChannelId = nd.channelId;
        log.info(`Default channel: ${nd.channelId} (${nd.label ?? "unlabeled"})`);

        // Probe both clients to surface the right diagnostic at boot.
        // Three failure modes, all silent until you try to post:
        //   - User can't see channel → wrong workspace token / stale
        //     default → user has no fallback either
        //   - Bot can't see channel → bot wasn't invited → falls back
        //     to user-mode at post time (still works, but noisier)
        //   - Both can't see it → completely wrong default channel
        const userOk = await this.userClient!.conversations.info({
          channel: this.defaultChannelId,
        })
          .then(() => true)
          .catch(() => false);
        const botOk = this.botClient
          ? await this.botClient.conversations
              .info({ channel: this.defaultChannelId })
              .then(() => true)
              .catch(() => false)
          : null;

        if (!userOk && botOk !== true) {
          log.error(
            { channelId: this.defaultChannelId, teamId: this.teamId, userOk, botOk },
            "Default notification channel is unreachable from BOTH user and bot tokens " +
              "in this workspace. The agent's replies will fail with channel_not_found. " +
              "Fix options: (a) Settings → Notifications, pick a different default channel; " +
              "(b) Settings → Slack, Remove + Reconnect this workspace to refresh the OAuth " +
              "token; (c) verify the channel still exists and you're a member.",
          );
          this.onAuthError?.(this.teamId, this.teamName ?? this.teamId, {
            kind: "user",
            reason: `Default Slack channel (${nd.label ?? nd.channelId}) is unreachable from ${this.teamName ?? this.teamId}. Pick a different default channel in Settings → Notifications, or Reconnect the workspace.`,
          });
        } else if (botOk === false) {
          // Bot isn't in the channel — posts will fall back to user-mode.
          // Log it once at boot so the operator knows to invite the bot.
          log.warn(
            { channelId: this.defaultChannelId, teamId: this.teamId },
            "Bot is not a member of the default channel. Agent will post as user " +
              "until you run `/invite @<your bot app name>` in this channel.",
          );
        }
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
        // Slack Connect DMs surface the sender's display info inline so we
        // can name them without an API call. Same shape as users.info.profile.
        user_profile?: {
          real_name?: string;
          display_name?: string;
          name?: string;
          email?: string;
        };
        // Sender's home team (different from this.teamId for Slack Connect).
        user_team?: string;
        team?: string;
      };

      // Seed the username cache from the event payload before any handler
      // runs lookupUserName. This is the key win for Slack Connect senders
      // — without this seed we'd fall through to the "external Slack user
      // (U073UDQAT0T)" label because users.info returns user_not_found for
      // them in our own workspace.
      if (e.user) this.seedUserFromEvent(e.user, e.user_profile, e.user_team ?? e.team);

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

      log.info(
        `Processing message: user=${e.user}, channel=${e.channel}, type=${e.channel_type}, isDefault=${isDefaultChannel}, myUserId=${this.userId}`,
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

    // ask_user button clicks. action_id is `ask_user_option:<index>`;
    // value is `<elicitation-id>::<option-index>`. The elicitation
    // manager resolves the pending request and we replace the original
    // question with a "you chose X" acknowledgement.
    this.app.action(/^ask_user_option:\d+$/, async ({ action, ack, respond }) => {
      await ack();
      const value = (action as { value?: string }).value;
      if (!value) return;
      const mgr = this.elicitationManager;
      if (!mgr) return;
      const { resolved, label } = mgr.resolveByButton(value);
      if (resolved && label) {
        await respond({
          replace_original: true,
          text: `:white_check_mark: You chose: *${label}*`,
        });
      }
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
    log.info(
      `Running via Socket Mode (user: ${this.userId}, bot: ${this.botUserId}, team: ${this.teamId}, defaultChannel: ${this.defaultChannelId})`,
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
    const tryClient = async (client: WebClient) => {
      await client.chat.postMessage({
        channel: channelId,
        text: markdownToSlackMrkdwn(text),
        thread_ts: threadId,
      });
    };

    // Prefer bot identity when available; fall back to user on failure.
    if (this.botClient) {
      try {
        await tryClient(this.botClient);
        return;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // channel_not_found from the BOT almost always means the bot
        // user wasn't invited to the channel. The user-token can still
        // post (the user is obviously in the channel — they're chatting
        // in it). Fall through to the user client so the agent doesn't
        // go dark.
        if (/channel_not_found|not_in_channel/i.test(message)) {
          log.warn(
            { channelId, teamId: this.teamId, message },
            "Bot isn't a member of this channel — falling back to user-mode for this post. " +
              "Permanent fix: in Slack, run `/invite @Nomos` (or your bot's app name) " +
              "inside this channel so the bot can post as itself.",
          );
          if (this.userClient) {
            await tryClient(this.userClient);
            return;
          }
        }
        throw err;
      }
    }

    // No bot — use user client directly.
    if (this.userClient) {
      try {
        await tryClient(this.userClient);
        return;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (/channel_not_found/i.test(message)) {
          log.error(
            { channelId, teamId: this.teamId, usingClient: "user", message },
            "User-token post failed: channel_not_found. The token can't see this channel. " +
              "If this is the default notification channel, see the boot-time error for fix " +
              "options (wrong workspace token or stale default).",
          );
        }
        throw err;
      }
    }
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
   * Post a message with Block Kit blocks. Used by the elicitation manager
   * to render `ask_user` questions with interactive buttons. Falls back to
   * plain text on platforms that ignore blocks. Same default-channel
   * guard as postMessage — we only render interactive UIs in the channel
   * the user actually watches.
   */
  async postBlocks(
    channelId: string,
    fallbackText: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    blocks: any[],
    threadId?: string,
  ): Promise<string | undefined> {
    if (channelId !== this.defaultChannelId) return undefined;
    const client = this.clientFor(channelId);
    if (!client) return undefined;
    const result = await client.chat.postMessage({
      channel: channelId,
      text: fallbackText,
      blocks,
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
    // lookupUserName may have just learned this is one of our own user IDs
    // (Slack Connect surfaces foreign-workspace IDs). Don't draft against ourselves.
    if (e.user && this.ownUserIds.has(e.user)) {
      return;
    }
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

  // Cache: user_id → sender's home team_id, if known from a recent event.
  // Lets lookupUserCrossWorkspace skip workspaces we know aren't the home.
  private userHomeTeam = new Map<string, string>();

  /**
   * Seed the username + home-team caches from a message event's inline
   * `user_profile`. Slack Connect messages always carry this; regular DMs
   * usually do too. Skip if a non-fallback name is already cached.
   */
  private seedUserFromEvent(
    userId: string,
    profile?: {
      real_name?: string;
      display_name?: string;
      name?: string;
      email?: string;
    },
    homeTeam?: string,
  ): void {
    if (homeTeam) this.userHomeTeam.set(userId, homeTeam);

    if (!profile) return;
    // Prefer real_name (full name); fall back to display_name, then name.
    const name = profile.real_name || profile.display_name || profile.name;
    if (!name) return;

    // Don't overwrite a previously-resolved real name with an inferior
    // event-provided one. Only seed if the cache is empty or holds the
    // "external Slack user (...)" fallback label.
    const existing = this.userNameCache.get(userId);
    if (existing && !existing.startsWith("external Slack user")) return;

    this.userNameCache.set(userId, name);

    // If profile.email matches the owner, mark this user_id as our own so
    // we skip drafting for messages "from us" on Slack Connect.
    if (this.ownerEmail && profile.email?.toLowerCase() === this.ownerEmail) {
      this.ownUserIds.add(userId);
    }
  }

  private async lookupUserName(userId: string): Promise<string> {
    const cached = this.userNameCache.get(userId);
    if (cached) return cached;

    // Try bot client first (more likely to have users:read scope), then user client
    for (const client of [this.botClient, this.userClient]) {
      if (!client) continue;
      try {
        const result = await (client as WebClient).users.info({ user: userId });
        // If this user's email matches the owner's, they're us (Slack Connect
        // surfaces the home-workspace user_id); remember so future drafting skips.
        const email = result.user?.profile?.email?.toLowerCase();
        if (this.ownerEmail && email && email === this.ownerEmail) {
          this.ownUserIds.add(userId);
        }
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

    // Final fallback: friendlier than dumping a raw user_id at the user.
    const label = `external Slack user (${userId})`;
    this.userNameCache.set(userId, label);
    return label;
  }

  /**
   * Try to resolve a user name using tokens from other workspaces.
   * Needed for Slack Connect users whose IDs belong to a different workspace.
   *
   * Optimized: if we know the sender's home team from a recent message
   * event (via `seedUserFromEvent`), try that workspace's token first.
   * Falls back to scanning every workspace.
   */
  private async lookupUserCrossWorkspace(userId: string): Promise<string | null> {
    try {
      const { listIntegrationsByPrefix } = await import("../../db/integrations.ts");
      const workspaces = await listIntegrationsByPrefix("slack-ws:");

      // Prefer the known home team first.
      const homeTeam = this.userHomeTeam.get(userId);
      const ordered = homeTeam
        ? [
            ...workspaces.filter((ws) => ws.name === `slack-ws:${homeTeam}`),
            ...workspaces.filter((ws) => ws.name !== `slack-ws:${homeTeam}`),
          ]
        : workspaces;

      for (const ws of ordered) {
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
