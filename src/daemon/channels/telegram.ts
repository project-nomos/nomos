/**
 * Thin Telegram channel adapter for the daemon.
 */

import { Bot, InputFile } from "grammy";
import type { ChannelAdapter, IncomingMessage, OutgoingMessage } from "../types.ts";
import type { DraftManager } from "../draft-manager.ts";
import { chunkResponse } from "../response-chunker.ts";
import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";

export interface TelegramAdapterOptions {
  onMessage: (msg: IncomingMessage) => void;
  draftManager?: DraftManager;
}

export class TelegramAdapter implements ChannelAdapter {
  readonly platform = "telegram";
  private bot: Bot | null = null;
  private onMessage: (msg: IncomingMessage) => void;
  private draftManager?: DraftManager;
  private lastIncomingContext = new Map<string, Record<string, unknown>>();

  constructor(options: TelegramAdapterOptions | ((msg: IncomingMessage) => void)) {
    if (typeof options === "function") {
      this.onMessage = options;
    } else {
      this.onMessage = options.onMessage;
      this.draftManager = options.draftManager;
    }
  }

  async start(): Promise<void> {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) throw new Error("TELEGRAM_BOT_TOKEN required");

    this.bot = new Bot(token);

    const me = await this.bot.api.getMe();
    console.log(`[telegram-adapter] Logged in as @${me.username}`);

    this.bot.on("message:text", (ctx) => {
      const chat = ctx.chat;
      if (!chat) return;

      // Private chats always respond; groups only when mentioned
      if (chat.type !== "private") {
        const botUsername = ctx.me.username;
        if (!ctx.message.text.includes(`@${botUsername}`)) return;
      }

      const botUsername = ctx.me.username;
      const content = ctx.message.text.replace(new RegExp(`@${botUsername}`, "g"), "").trim();
      if (!content) return;

      const senderName = ctx.from?.first_name
        ? `${ctx.from.first_name}${ctx.from.last_name ? ` ${ctx.from.last_name}` : ""}`
        : String(ctx.from?.id ?? "unknown");
      const channelId = String(chat.id);

      // Cache incoming context for draft notifications
      const prevCtx = this.lastIncomingContext.get(channelId);
      const prevOriginal =
        prevCtx?.senderName === senderName ? (prevCtx.originalMessage as string) : "";
      this.lastIncomingContext.set(channelId, {
        senderName,
        messageType: chat.type === "private" ? "dm" : "mention",
        originalMessage: prevOriginal ? `${prevOriginal}\n${content}` : content,
      });

      this.onMessage({
        id: randomUUID(),
        platform: "telegram",
        channelId,
        userId: String(ctx.from?.id ?? "unknown"),
        content,
        timestamp: new Date(),
        metadata: { senderName },
      });
    });

    // Start long polling (non-blocking)
    this.bot.start();
  }

  async stop(): Promise<void> {
    if (this.bot) {
      await this.bot.stop();
      this.bot = null;
    }
  }

  async send(message: OutgoingMessage): Promise<void> {
    if (this.draftManager) {
      const cachedCtx = this.lastIncomingContext.get(message.channelId) ?? {};
      await this.draftManager.createDraft(message, "telegram", {
        messageType: "message",
        channelId: message.channelId,
        ...cachedCtx,
      });
      this.lastIncomingContext.delete(message.channelId);
      return;
    }
    await this.sendDirect(message);
  }

  /** Send directly to Telegram, bypassing draft approval. Called by DraftManager after approval. */
  async sendDirect(message: OutgoingMessage): Promise<void> {
    if (!this.bot) return;
    const chatId = message.channelId;
    const result = chunkResponse(message.content, "telegram");

    for (const text of result.chunks) {
      await this.bot.api.sendMessage(chatId, text);
    }

    if (result.strategy === "file" && result.fullText && result.filename) {
      await this.bot.api.sendDocument(
        chatId,
        new InputFile(Buffer.from(result.fullText, "utf-8"), result.filename),
      );
    }
  }
}
