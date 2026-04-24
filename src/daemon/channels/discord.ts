/**
 * Thin Discord channel adapter for the daemon.
 */

import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type Message,
  type TextChannel,
} from "discord.js";
import type { ChannelAdapter, IncomingMessage, OutgoingMessage } from "../types.ts";
import type { DraftManager } from "../draft-manager.ts";
import { chunkResponse } from "../response-chunker.ts";
import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { AttachmentBuilder } from "discord.js";

export interface DiscordAdapterOptions {
  onMessage: (msg: IncomingMessage) => void;
  draftManager?: DraftManager;
}

export class DiscordAdapter implements ChannelAdapter {
  readonly platform = "discord";
  private client: Client | null = null;
  private onMessage: (msg: IncomingMessage) => void;
  private draftManager?: DraftManager;
  // Map channelId → last Message for reply
  private lastMessages = new Map<string, Message>();
  // Cache last incoming context per channel for draft notifications
  private lastIncomingContext = new Map<string, Record<string, unknown>>();

  constructor(options: DiscordAdapterOptions | ((msg: IncomingMessage) => void)) {
    if (typeof options === "function") {
      // Backwards compat
      this.onMessage = options;
    } else {
      this.onMessage = options.onMessage;
      this.draftManager = options.draftManager;
    }
  }

  async start(): Promise<void> {
    const token = process.env.DISCORD_BOT_TOKEN;
    if (!token) throw new Error("DISCORD_BOT_TOKEN required");

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Channel, Partials.Message],
    });

    this.client.once(Events.ClientReady, (c) => {
      console.log(`[discord-adapter] Logged in as ${c.user.tag}`);
    });

    this.client.on(Events.MessageCreate, (message) => {
      const botId = this.client?.user?.id;
      if (!botId) return;
      if (message.author.id === botId || message.author.bot) return;
      // DMs always, guilds only when mentioned
      if (message.guild && !message.mentions.has(botId)) return;

      const content = message.content.replace(new RegExp(`<@!?${botId}>`, "g"), "").trim();
      if (!content) return;

      this.lastMessages.set(message.channelId, message);

      // Cache incoming context for draft notifications
      const senderName = message.author.displayName ?? message.author.username;
      const prevCtx = this.lastIncomingContext.get(message.channelId);
      const prevOriginal =
        prevCtx?.senderName === senderName ? (prevCtx.originalMessage as string) : "";
      this.lastIncomingContext.set(message.channelId, {
        senderName,
        messageType: message.guild ? "mention" : "dm",
        channelName: message.guild ? (message.channel as TextChannel).name : undefined,
        originalMessage: prevOriginal ? `${prevOriginal}\n${content}` : content,
      });

      this.onMessage({
        id: randomUUID(),
        platform: "discord",
        channelId: message.channelId,
        userId: message.author.id,
        content,
        timestamp: new Date(),
        metadata: { guildId: message.guild?.id, senderName },
      });
    });

    await this.client.login(token);
  }

  async stop(): Promise<void> {
    if (this.client) {
      this.client.destroy();
      this.client = null;
    }
    this.lastMessages.clear();
  }

  async send(message: OutgoingMessage): Promise<void> {
    if (this.draftManager) {
      const cachedCtx = this.lastIncomingContext.get(message.channelId) ?? {};
      await this.draftManager.createDraft(message, "discord", {
        messageType: "message",
        channelId: message.channelId,
        ...cachedCtx,
      });
      this.lastIncomingContext.delete(message.channelId);
      return;
    }
    await this.sendDirect(message);
  }

  /** Send directly to Discord, bypassing draft approval. Called by DraftManager after approval. */
  async sendDirect(message: OutgoingMessage): Promise<void> {
    if (!this.client) return;

    const channel = await this.client.channels.fetch(message.channelId);
    if (!channel || !("send" in channel)) return;

    const result = chunkResponse(message.content, "discord");
    const originalMsg = this.lastMessages.get(message.channelId);

    const files =
      result.strategy === "file" && result.fullText && result.filename
        ? [new AttachmentBuilder(Buffer.from(result.fullText, "utf-8"), { name: result.filename })]
        : undefined;

    for (let i = 0; i < result.chunks.length; i++) {
      const text = result.chunks[i];
      const attachFiles = i === result.chunks.length - 1 ? files : undefined;

      if (originalMsg) {
        await originalMsg.reply({ content: text, files: attachFiles });
      } else {
        await (channel as TextChannel).send({ content: text, files: attachFiles });
      }
    }
  }
}
