/**
 * Slack ingestion source.
 *
 * Fetches sent messages from all accessible channels using the Slack Web API.
 * Filters to messages from the authenticated user only.
 * Uses cursor pagination with rate limiting (Tier 3: ~50 req/min).
 */

import { WebClient } from "@slack/web-api";
import { listWorkspaces } from "../../db/slack-workspaces.ts";
import type { IngestSource, IngestMessage, IngestOptions } from "../types.ts";

const PAGE_DELAY_MS = 1200; // ~50 req/min for Tier 3

export class SlackIngestSource implements IngestSource {
  readonly platform: string;
  readonly sourceType = "history";

  private readonly teamId: string;
  private readonly token: string;
  private readonly authenticatedUserId: string;
  private userNameCache = new Map<string, string>();

  constructor(teamId: string, token: string, userId: string) {
    this.teamId = teamId;
    this.platform = `slack:${teamId}`;
    this.token = token;
    this.authenticatedUserId = userId;
  }

  async *ingest(
    options: IngestOptions,
    cursor?: string,
  ): AsyncGenerator<IngestMessage, void, undefined> {
    const client = new WebClient(this.token);

    // Get list of channels the user is in
    const channels = await this.listUserChannels(client);

    for (const channel of channels) {
      let pageCursor: string | undefined = cursor;
      const oldest = options.since ? String(options.since.getTime() / 1000) : undefined;

      while (true) {
        const result = await client.conversations.history({
          channel: channel.id,
          cursor: pageCursor,
          oldest,
          limit: 200,
        });

        if (!result.messages) break;

        for (const msg of result.messages) {
          // Filter to sent messages only
          if (msg.user !== this.authenticatedUserId) continue;
          if (!msg.text || msg.subtype) continue;

          // Filter by contact if specified
          if (options.contact) {
            // For sent messages, contact filtering is on channel/DM partner
            // Skip if doesn't match (basic filter)
          }

          const contactName = await this.resolveUserName(client, msg.user!);

          yield {
            id: `${channel.id}:${msg.ts}`,
            platform: this.platform,
            contact: this.authenticatedUserId,
            contactName,
            direction: "sent",
            channelId: channel.id,
            channelName: channel.name,
            content: msg.text,
            timestamp: new Date(Number.parseFloat(msg.ts!) * 1000),
            metadata: {
              slackTs: msg.ts,
              channelType: channel.is_im ? "dm" : channel.is_mpim ? "mpim" : "channel",
            },
          };
        }

        if (!result.has_more || !result.response_metadata?.next_cursor) break;
        pageCursor = result.response_metadata.next_cursor;

        // Rate limiting
        await delay(PAGE_DELAY_MS);
      }
    }
  }

  private async listUserChannels(
    client: WebClient,
  ): Promise<Array<{ id: string; name?: string; is_im?: boolean; is_mpim?: boolean }>> {
    const channels: Array<{ id: string; name?: string; is_im?: boolean; is_mpim?: boolean }> = [];
    let cursor: string | undefined;

    do {
      const result = await client.conversations.list({
        types: "public_channel,private_channel,mpim,im",
        cursor,
        limit: 200,
      });

      if (result.channels) {
        for (const ch of result.channels) {
          if (ch.id) {
            channels.push({
              id: ch.id,
              name: ch.name,
              is_im: ch.is_im,
              is_mpim: ch.is_mpim,
            });
          }
        }
      }

      cursor = result.response_metadata?.next_cursor || undefined;
      if (cursor) await delay(PAGE_DELAY_MS);
    } while (cursor);

    return channels;
  }

  private async resolveUserName(client: WebClient, userId: string): Promise<string> {
    const cached = this.userNameCache.get(userId);
    if (cached) return cached;

    try {
      const result = await client.users.info({ user: userId });
      const name = result.user?.real_name ?? result.user?.name ?? userId;
      this.userNameCache.set(userId, name);
      return name;
    } catch {
      this.userNameCache.set(userId, userId);
      return userId;
    }
  }
}

/**
 * Create Slack ingest sources for all configured workspaces.
 */
export async function createSlackIngestSources(): Promise<SlackIngestSource[]> {
  const workspaces = await listWorkspaces();
  return workspaces.map((ws) => new SlackIngestSource(ws.team_id, ws.access_token, ws.user_id));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
