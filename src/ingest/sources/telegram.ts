/**
 * Telegram ingestion source.
 *
 * Fetches recent message history using grammY's getUpdates.
 * Note: Telegram Bot API only retains ~24h of updates, so this
 * captures what's available. For richer history, use a Telegram
 * client library (e.g., GramJS) with a user account.
 *
 * Filters to sent messages (from the bot) only.
 */

import { Bot } from "grammy";
import type { IngestSource, IngestMessage, IngestOptions } from "../types.ts";

export class TelegramIngestSource implements IngestSource {
  readonly platform = "telegram";
  readonly sourceType = "history";

  private token: string;

  constructor(token?: string) {
    this.token = token ?? process.env.TELEGRAM_BOT_TOKEN ?? "";
  }

  async *ingest(
    options: IngestOptions,
    cursor?: string,
  ): AsyncGenerator<IngestMessage, void, undefined> {
    if (!this.token) {
      throw new Error("TELEGRAM_BOT_TOKEN required for Telegram ingestion");
    }

    const bot = new Bot(this.token);
    const me = await bot.api.getMe();
    const botId = me.id;

    let offset = cursor ? Number.parseInt(cursor, 10) : 0;

    while (true) {
      const updates = await bot.api.getUpdates({
        offset,
        limit: 100,
        allowed_updates: ["message"],
      });

      if (updates.length === 0) break;

      for (const update of updates) {
        const msg = update.message;
        if (!msg?.text) continue;

        // Filter to sent messages only (from the bot)
        if (msg.from?.id !== botId) continue;

        // Filter by date
        const timestamp = new Date(msg.date * 1000);
        if (options.since && timestamp < options.since) continue;

        const chatName =
          msg.chat.type === "private"
            ? "DM"
            : (("title" in msg.chat ? msg.chat.title : undefined) ?? `chat:${msg.chat.id}`);

        yield {
          id: `${msg.chat.id}:${msg.message_id}`,
          platform: "telegram",
          contact: String(msg.from.id),
          contactName: [msg.from.first_name, msg.from.last_name].filter(Boolean).join(" "),
          direction: "sent",
          channelId: String(msg.chat.id),
          channelName: chatName,
          content: msg.text,
          timestamp,
          metadata: {
            chatType: msg.chat.type,
            messageId: msg.message_id,
          },
        };
      }

      // Move offset past the last update
      offset = updates[updates.length - 1].update_id + 1;
    }
  }
}
