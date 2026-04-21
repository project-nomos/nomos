/**
 * Slack ingestion source.
 *
 * Uses search.messages (Tier 2: 20 req/min) to find all messages from the
 * authenticated user in a single paginated query. This is dramatically more
 * efficient than the previous approach of listing all channels and calling
 * conversations.history on each one (which required N+1 API calls for N
 * channels, most returning zero results).
 *
 * search.messages requires a user token (xoxp-), which is what the workspace
 * system uses.
 */

import { WebClient } from "@slack/web-api";
import { listWorkspaces } from "../../db/slack-workspaces.ts";
import type { IngestSource, IngestMessage, IngestOptions } from "../types.ts";

/** Delay between search pages (Tier 2: 20 req/min, we target ~6 req/min). */
const PAGE_DELAY_MS = 10_000;

export class SlackIngestSource implements IngestSource {
  readonly platform: string;
  readonly sourceType = "history";

  private readonly teamId: string;
  private readonly token: string;
  private readonly authenticatedUserId: string;

  constructor(teamId: string, token: string, userId: string) {
    this.teamId = teamId;
    this.platform = `slack:${teamId}`;
    this.token = token;
    this.authenticatedUserId = userId;
  }

  async *ingest(
    options: IngestOptions,
    _cursor?: string,
  ): AsyncGenerator<IngestMessage, void, undefined> {
    const client = new WebClient(this.token);

    // Build search query: messages from the authenticated user
    let query = `from:<@${this.authenticatedUserId}>`;
    if (options.since) {
      // Slack search accepts after:YYYY-MM-DD
      const dateStr = options.since.toISOString().slice(0, 10);
      query += ` after:${dateStr}`;
    }

    console.log(`[slack-ingest] Searching: ${query}`);

    let page = 1;
    let totalPages = 1;

    while (page <= totalPages) {
      const result = await client.search.messages({
        query,
        sort: "timestamp",
        sort_dir: "asc",
        count: 100,
        page,
      });

      const matches = result.messages?.matches;
      if (!matches || matches.length === 0) break;

      totalPages = result.messages?.paging?.pages ?? 1;
      console.log(`[slack-ingest] Page ${page}/${totalPages} -- ${matches.length} messages`);

      for (const match of matches) {
        if (!match.text) continue;

        // Extract channel info from the match
        const channelId = match.channel?.id ?? "";
        const channelName = match.channel?.name;
        const isIm = match.channel?.is_im;
        const isMpim = match.channel?.is_mpim;

        yield {
          id: `${channelId}:${match.ts}`,
          platform: this.platform,
          contact: this.authenticatedUserId,
          contactName: match.username ?? this.authenticatedUserId,
          direction: "sent",
          channelId,
          channelName,
          content: match.text,
          timestamp: new Date(Number.parseFloat(match.ts!) * 1000),
          metadata: {
            slackTs: match.ts,
            channelType: isIm ? "dm" : isMpim ? "mpim" : "channel",
            permalink: match.permalink,
          },
        };
      }

      page++;
      if (page <= totalPages) {
        await delay(PAGE_DELAY_MS);
      }
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
