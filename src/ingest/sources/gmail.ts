/**
 * Gmail ingestion source.
 *
 * Fetches sent emails using the Gmail API.
 * Only ingests from the Sent folder (in:sent) to avoid spam/newsletters.
 * Saves historyId as cursor for delta sync.
 */

import { GoogleAuth } from "google-auth-library";
import type { IngestSource, IngestMessage, IngestOptions } from "../types.ts";

const PAGE_DELAY_MS = 200; // Gmail: 250 quota units/sec
const MAX_RESULTS = 100;

interface GmailMessage {
  id: string;
  threadId: string;
  historyId: string;
  payload: {
    headers: Array<{ name: string; value: string }>;
    body?: { data?: string };
    parts?: Array<{ mimeType: string; body?: { data?: string } }>;
  };
  internalDate: string;
}

interface GmailListResponse {
  messages?: Array<{ id: string; threadId: string }>;
  nextPageToken?: string;
  resultSizeEstimate?: number;
}

export class GmailIngestSource implements IngestSource {
  readonly platform = "gmail";
  readonly sourceType = "history";

  private auth: GoogleAuth;
  private latestHistoryId: string | null = null;

  constructor() {
    this.auth = new GoogleAuth({
      scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    });
  }

  async *ingest(
    options: IngestOptions,
    cursor?: string,
  ): AsyncGenerator<IngestMessage, void, undefined> {
    const client = await this.auth.getClient();
    const tokenResponse = await client.getAccessToken();
    const accessToken = tokenResponse.token;
    if (!accessToken) {
      throw new Error(
        "Failed to obtain Gmail access token. Run: gcloud auth application-default login",
      );
    }

    // Build query: sent folder only
    let query = "in:sent";
    if (options.since) {
      const dateStr = options.since.toISOString().slice(0, 10);
      query += ` after:${dateStr}`;
    }
    if (options.contact) {
      query += ` to:${options.contact}`;
    }

    let pageToken: string | undefined = cursor || undefined;

    while (true) {
      const listUrl = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
      listUrl.searchParams.set("q", query);
      listUrl.searchParams.set("maxResults", String(MAX_RESULTS));
      if (pageToken) listUrl.searchParams.set("pageToken", pageToken);

      const listResp = await fetch(listUrl.toString(), {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (!listResp.ok) {
        const body = await listResp.text();
        throw new Error(`Gmail API list error ${listResp.status}: ${body}`);
      }

      const listData = (await listResp.json()) as GmailListResponse;
      if (!listData.messages || listData.messages.length === 0) break;

      // Fetch individual messages (5 quota units each)
      for (const msgRef of listData.messages) {
        const msg = await this.fetchMessage(accessToken, msgRef.id);
        if (!msg) continue;

        const headers = new Map(msg.payload.headers.map((h) => [h.name.toLowerCase(), h.value]));
        const to = headers.get("to") ?? "";
        const subject = headers.get("subject") ?? "(no subject)";
        const body = this.extractBody(msg);

        if (!body) continue;

        // Track latest historyId for delta sync
        if (!this.latestHistoryId || msg.historyId > this.latestHistoryId) {
          this.latestHistoryId = msg.historyId;
        }

        const content = subject ? `Subject: ${subject}\n\n${body}` : body;

        yield {
          id: msg.id,
          platform: "gmail",
          contact: to.split(",")[0]?.trim() ?? "unknown",
          direction: "sent",
          channelId: msg.threadId,
          channelName: subject,
          threadId: msg.threadId,
          content,
          timestamp: new Date(Number.parseInt(msg.internalDate, 10)),
          metadata: {
            gmailId: msg.id,
            threadId: msg.threadId,
            historyId: msg.historyId,
            to,
            subject,
          },
        };

        await delay(PAGE_DELAY_MS);
      }

      if (!listData.nextPageToken) break;
      pageToken = listData.nextPageToken;
    }
  }

  private async fetchMessage(accessToken: string, messageId: string): Promise<GmailMessage | null> {
    const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`;
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!resp.ok) {
      if (resp.status === 429) {
        // Rate limited — wait and retry
        await delay(5000);
        return this.fetchMessage(accessToken, messageId);
      }
      return null;
    }

    return (await resp.json()) as GmailMessage;
  }

  private extractBody(msg: GmailMessage): string | null {
    // Try plain text body first
    if (msg.payload.body?.data) {
      return decodeBase64Url(msg.payload.body.data);
    }

    // Check parts for text/plain
    if (msg.payload.parts) {
      const textPart = msg.payload.parts.find((p) => p.mimeType === "text/plain");
      if (textPart?.body?.data) {
        return decodeBase64Url(textPart.body.data);
      }

      // Fall back to text/html, strip tags
      const htmlPart = msg.payload.parts.find((p) => p.mimeType === "text/html");
      if (htmlPart?.body?.data) {
        const html = decodeBase64Url(htmlPart.body.data);
        return stripHtml(html);
      }
    }

    return null;
  }
}

function decodeBase64Url(data: string): string {
  const base64 = data.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(base64, "base64").toString("utf-8");
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
