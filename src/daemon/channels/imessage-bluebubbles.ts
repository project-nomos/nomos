/**
 * BlueBubbles iMessage adapter — connects to a BlueBubbles macOS server
 * for full bidirectional iMessage support via REST API + webhooks.
 *
 * Unlike the chat.db adapter, this works cross-platform: the daemon
 * can run on any machine while a Mac with BlueBubbles acts as relay.
 */

import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "../types.ts";

const MAX_LENGTH = 4000;
const DEFAULT_PORT = 1234;

export interface BlueBubblesConfig {
  serverUrl: string;
  password: string;
  /** Port for the local webhook receiver. Default: 8803 */
  webhookPort?: number;
  /** Path for webhook endpoint. Default: /bluebubbles-webhook */
  webhookPath?: string;
  /** Webhook password for authenticating inbound events. */
  webhookPassword?: string;
  /** Send read receipts. Default: false */
  sendReadReceipts?: boolean;
  /** Allowed chat identifiers (empty = allow all). */
  allowedChats?: Set<string>;
}

interface BBMessage {
  guid: string;
  text: string;
  dateCreated: number;
  isFromMe: boolean;
  handle?: { address: string };
  chats?: Array<{
    guid: string;
    chatIdentifier: string;
    displayName: string | null;
    style: number;
  }>;
}

interface BBWebhookPayload {
  type: string;
  data: BBMessage;
}

function chunk(text: string): string[] {
  if (text.length <= MAX_LENGTH) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= MAX_LENGTH) {
      chunks.push(remaining);
      break;
    }
    let idx = remaining.lastIndexOf("\n", MAX_LENGTH);
    if (idx < MAX_LENGTH / 2) idx = remaining.lastIndexOf(" ", MAX_LENGTH);
    if (idx < MAX_LENGTH / 2) idx = MAX_LENGTH;
    chunks.push(remaining.slice(0, idx));
    remaining = remaining.slice(idx).trimStart();
  }
  return chunks;
}

export class BlueBubblesAdapter {
  private config: BlueBubblesConfig;
  private onMessage: (msg: IncomingMessage) => void;
  private webhookServer?: { close: () => void };

  constructor(config: BlueBubblesConfig, onMessage: (msg: IncomingMessage) => void) {
    this.config = config;
    this.onMessage = onMessage;
  }

  /** Ping the BlueBubbles server to verify connectivity. */
  async ping(): Promise<boolean> {
    try {
      const res = await fetch(
        `${this.config.serverUrl}/api/v1/ping?password=${this.config.password}`,
      );
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Start the webhook server to receive incoming messages. */
  async startWebhook(): Promise<void> {
    const { createServer } = await import("node:http");
    const port = this.config.webhookPort ?? 8803;
    const path = this.config.webhookPath ?? "/bluebubbles-webhook";
    const webhookPassword = this.config.webhookPassword ?? this.config.password;

    const server = createServer(async (req, res) => {
      if (req.method !== "POST" || req.url?.split("?")[0] !== path) {
        res.writeHead(404);
        res.end();
        return;
      }

      // Authenticate webhook
      const url = new URL(req.url, `http://localhost:${port}`);
      const reqPassword = url.searchParams.get("password") ?? req.headers["x-bluebubbles-password"];
      if (reqPassword !== webhookPassword) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }

      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(chunk as Buffer);
        }
        const body = Buffer.concat(chunks).toString("utf-8");
        const payload: BBWebhookPayload = JSON.parse(body);

        if (payload.type === "new-message" && payload.data && !payload.data.isFromMe) {
          this.handleIncomingMessage(payload.data);
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
      } catch (err) {
        console.error("[bluebubbles] Webhook parse error:", err);
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid payload" }));
      }
    });

    await new Promise<void>((resolve) => {
      server.listen(port, () => {
        console.log(`[bluebubbles] Webhook listening on port ${port}`);
        resolve();
      });
    });

    this.webhookServer = server;
  }

  private handleIncomingMessage(msg: BBMessage): void {
    const chat = msg.chats?.[0];
    const handle = msg.handle?.address ?? "unknown";
    const chatId = chat?.chatIdentifier ?? handle;

    // Check allowlist
    if (this.config.allowedChats && this.config.allowedChats.size > 0) {
      if (!this.config.allowedChats.has(handle) && !this.config.allowedChats.has(chatId)) {
        return;
      }
    }

    if (!msg.text || msg.text.trim() === "") return;

    this.onMessage({
      id: randomUUID(),
      platform: "imessage",
      channelId: chatId,
      userId: handle,
      content: msg.text,
      timestamp: new Date(msg.dateCreated),
    });
  }

  /** Send a text message via BlueBubbles REST API. */
  async sendMessage(chatGuid: string, text: string): Promise<void> {
    const chunks = chunk(text);
    for (const c of chunks) {
      const res = await fetch(
        `${this.config.serverUrl}/api/v1/message/text?password=${this.config.password}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chatGuid,
            message: c,
          }),
        },
      );

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`BlueBubbles send failed: HTTP ${res.status} — ${body}`);
      }
    }
  }

  /** Send a tapback reaction. */
  async sendReaction(chatGuid: string, messageGuid: string, reaction: string): Promise<void> {
    const res = await fetch(
      `${this.config.serverUrl}/api/v1/message/react?password=${this.config.password}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chatGuid,
          selectedMessageGuid: messageGuid,
          reaction,
        }),
      },
    );

    if (!res.ok) {
      throw new Error(`BlueBubbles reaction failed: HTTP ${res.status}`);
    }
  }

  /** Send a typing indicator. */
  async sendTypingIndicator(chatGuid: string, start: boolean): Promise<void> {
    try {
      await fetch(
        `${this.config.serverUrl}/api/v1/chat/${encodeURIComponent(chatGuid)}/typing?password=${this.config.password}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: start ? "start" : "stop" }),
        },
      );
    } catch {
      // Typing indicators are best-effort
    }
  }

  /** Mark a chat as read. */
  async markRead(chatGuid: string): Promise<void> {
    if (!this.config.sendReadReceipts) return;
    try {
      await fetch(
        `${this.config.serverUrl}/api/v1/chat/${encodeURIComponent(chatGuid)}/read?password=${this.config.password}`,
        {
          method: "POST",
        },
      );
    } catch {
      // Read receipts are best-effort
    }
  }

  /** Stop the webhook server. */
  async stop(): Promise<void> {
    this.webhookServer?.close();
    this.webhookServer = undefined;
  }
}
