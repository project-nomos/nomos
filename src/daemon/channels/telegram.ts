/**
 * Thin Telegram channel adapter for the daemon.
 */

import { Bot, InputFile } from "grammy";
import type { ChannelAdapter, IncomingMessage, OutgoingMessage } from "../types.ts";
import { chunkResponse } from "../response-chunker.ts";
import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";

export class TelegramAdapter implements ChannelAdapter {
  readonly platform = "telegram";
  private bot: Bot | null = null;
  private onMessage: (msg: IncomingMessage) => void;

  constructor(onMessage: (msg: IncomingMessage) => void) {
    this.onMessage = onMessage;
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

      this.onMessage({
        id: randomUUID(),
        platform: "telegram",
        channelId: String(chat.id),
        userId: String(ctx.from?.id ?? "unknown"),
        content,
        timestamp: new Date(),
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
    if (!this.bot) return;
    const chatId = message.channelId;
    const result = chunkResponse(message.content, "telegram");

    for (const text of result.chunks) {
      await this.bot.api.sendMessage(chatId, text);
    }

    // Upload full response as document for very long messages
    if (result.strategy === "file" && result.fullText && result.filename) {
      await this.bot.api.sendDocument(
        chatId,
        new InputFile(Buffer.from(result.fullText, "utf-8"), result.filename),
      );
    }
  }
}
