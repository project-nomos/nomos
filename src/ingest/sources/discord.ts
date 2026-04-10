/**
 * Discord ingestion source.
 *
 * Fetches sent messages from all accessible channels using discord.js.
 * Filters to messages from the bot's associated user (sent only).
 * Uses cursor pagination with rate limiting.
 */

import {
  Client,
  GatewayIntentBits,
  type TextChannel,
  type DMChannel,
  ChannelType,
} from "discord.js";
import type { IngestSource, IngestMessage, IngestOptions } from "../types.ts";

const PAGE_DELAY_MS = 1000; // Discord rate limit: ~30 req/30s per channel
const FETCH_LIMIT = 100;

export class DiscordIngestSource implements IngestSource {
  readonly platform = "discord";
  readonly sourceType = "history";

  private token: string;

  constructor(token?: string) {
    this.token = token ?? process.env.DISCORD_BOT_TOKEN ?? "";
  }

  async *ingest(
    options: IngestOptions,
    cursor?: string,
  ): AsyncGenerator<IngestMessage, void, undefined> {
    if (!this.token) {
      throw new Error("DISCORD_BOT_TOKEN required for Discord ingestion");
    }

    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
      ],
    });

    try {
      await client.login(this.token);
      // Wait for ready
      await new Promise<void>((resolve) => client.once("ready", () => resolve()));

      const botUser = client.user;
      if (!botUser) throw new Error("Discord client not ready");

      // Collect accessible text channels + DMs
      const channels: Array<TextChannel | DMChannel> = [];

      for (const guild of client.guilds.cache.values()) {
        const guildChannels = await guild.channels.fetch();
        for (const ch of guildChannels.values()) {
          if (ch && ch.type === ChannelType.GuildText) {
            channels.push(ch as TextChannel);
          }
        }
      }

      // Also fetch DM channels from cache
      for (const ch of client.channels.cache.values()) {
        if (ch.type === ChannelType.DM) {
          channels.push(ch as DMChannel);
        }
      }

      for (const channel of channels) {
        let before: string | undefined = cursor;

        while (true) {
          const messages = await channel.messages.fetch({
            limit: FETCH_LIMIT,
            ...(before ? { before } : {}),
          });

          if (messages.size === 0) break;

          for (const msg of messages.values()) {
            // Filter to sent messages only (from the bot user)
            if (msg.author.id !== botUser.id) continue;
            if (!msg.content) continue;

            // Filter by date
            if (options.since && msg.createdAt < options.since) {
              return; // Messages are in reverse chronological order
            }

            const channelName =
              channel.type === ChannelType.DM ? `DM` : (channel as TextChannel).name;

            yield {
              id: msg.id,
              platform: "discord",
              contact: msg.author.id,
              contactName: msg.author.displayName ?? msg.author.username,
              direction: "sent",
              channelId: channel.id,
              channelName,
              content: msg.content,
              timestamp: msg.createdAt,
              metadata: {
                guildId:
                  channel.type === ChannelType.GuildText
                    ? (channel as TextChannel).guildId
                    : undefined,
              },
            };
          }

          // Get the oldest message ID for pagination
          const oldest = messages.last();
          if (!oldest || messages.size < FETCH_LIMIT) break;
          before = oldest.id;

          await delay(PAGE_DELAY_MS);
        }
      }
    } finally {
      await client.destroy();
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
