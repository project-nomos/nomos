/**
 * Thin iMessage channel adapter for the daemon.
 *
 * Supports two modes:
 * - "chatdb" (default): macOS only. Reads from ~/Library/Messages/chat.db,
 *   sends via AppleScript. Zero setup, but macOS-only.
 * - "bluebubbles": Connects to a BlueBubbles server via REST + webhooks.
 *   Works cross-platform — the daemon can run anywhere while a Mac relays.
 *
 * Mode is selected via IMESSAGE_MODE env var or Settings UI.
 */

import { randomUUID } from "node:crypto";
import { IMessageReceiver } from "./imessage-receiver.ts";
import { sendIMessage } from "./imessage-sender.ts";
import { BlueBubblesAdapter, type BlueBubblesConfig } from "./imessage-bluebubbles.ts";
import type { ChannelAdapter, IncomingMessage, OutgoingMessage } from "../types.ts";

const MAX_LENGTH = 4000;

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

/** Chat style: 45 = group chat (43 = 1:1, handled as the else case). */
const STYLE_GROUP = 45;

export type IMessageMode = "chatdb" | "bluebubbles";

interface ChatMeta {
  chatGuid: string;
  chatStyle: number;
  handleIdentifier: string;
}

export class IMessageAdapter implements ChannelAdapter {
  readonly platform = "imessage";
  private imessageMode: IMessageMode;
  private onMessage: (msg: IncomingMessage) => void;

  // chatdb mode
  private receiver: IMessageReceiver | null = null;
  private chatMeta = new Map<string, ChatMeta>();

  // bluebubbles mode
  private bbAdapter: BlueBubblesAdapter | null = null;
  /** Map chatIdentifier → chatGuid for BlueBubbles send routing. */
  private bbChatGuids = new Map<string, string>();

  constructor(onMessage: (msg: IncomingMessage) => void) {
    this.onMessage = onMessage;
    this.imessageMode = (process.env.IMESSAGE_MODE as IMessageMode) || "chatdb";
  }

  async start(): Promise<void> {
    if (this.imessageMode === "bluebubbles") {
      await this.startBlueBubbles();
    } else {
      await this.startChatDb();
    }
  }

  private async startChatDb(): Promise<void> {
    if (process.platform !== "darwin") {
      throw new Error(
        "iMessage chat.db mode requires macOS. Use IMESSAGE_MODE=bluebubbles for cross-platform.",
      );
    }

    const allowedChats = process.env.IMESSAGE_ALLOWED_CHATS
      ? new Set(process.env.IMESSAGE_ALLOWED_CHATS.split(",").map((s) => s.trim()))
      : null;

    this.receiver = new IMessageReceiver((msg) => {
      if (allowedChats) {
        const allowed =
          allowedChats.has(msg.handleIdentifier) || allowedChats.has(msg.chatIdentifier);
        if (!allowed) return;
      }

      this.chatMeta.set(msg.chatIdentifier, {
        chatGuid: msg.chatGuid,
        chatStyle: msg.chatStyle,
        handleIdentifier: msg.handleIdentifier,
      });

      this.onMessage({
        id: randomUUID(),
        platform: "imessage",
        channelId: msg.chatIdentifier,
        userId: msg.handleIdentifier,
        content: msg.text,
        timestamp: new Date(),
      });
    });

    this.receiver.start();
    console.log("[imessage-adapter] Started in chat.db mode — watching for incoming messages");
  }

  private async startBlueBubbles(): Promise<void> {
    const serverUrl = process.env.BLUEBUBBLES_SERVER_URL;
    const password = process.env.BLUEBUBBLES_PASSWORD;

    if (!serverUrl || !password) {
      throw new Error("BlueBubbles mode requires BLUEBUBBLES_SERVER_URL and BLUEBUBBLES_PASSWORD");
    }

    const allowedChats = process.env.IMESSAGE_ALLOWED_CHATS
      ? new Set(process.env.IMESSAGE_ALLOWED_CHATS.split(",").map((s) => s.trim()))
      : undefined;

    const config: BlueBubblesConfig = {
      serverUrl,
      password,
      webhookPort: process.env.BLUEBUBBLES_WEBHOOK_PORT
        ? Number.parseInt(process.env.BLUEBUBBLES_WEBHOOK_PORT)
        : 8803,
      webhookPassword: process.env.BLUEBUBBLES_WEBHOOK_PASSWORD ?? password,
      sendReadReceipts: process.env.BLUEBUBBLES_READ_RECEIPTS === "true",
      allowedChats,
    };

    this.bbAdapter = new BlueBubblesAdapter(config, (msg) => {
      // Track chat GUID for send routing
      // The chatIdentifier comes through as channelId
      this.bbChatGuids.set(msg.channelId, `iMessage;+;${msg.channelId}`);
      this.onMessage(msg);
    });

    // Verify connectivity
    const reachable = await this.bbAdapter.ping();
    if (!reachable) {
      console.warn(
        `[imessage-adapter] BlueBubbles server at ${serverUrl} is not reachable. Will retry on message send.`,
      );
    }

    await this.bbAdapter.startWebhook();
    console.log(`[imessage-adapter] Started in BlueBubbles mode — server: ${serverUrl}`);
  }

  async stop(): Promise<void> {
    if (this.imessageMode === "bluebubbles" && this.bbAdapter) {
      await this.bbAdapter.stop();
      this.bbAdapter = null;
      this.bbChatGuids.clear();
    } else {
      if (this.receiver) {
        this.receiver.stop();
        this.receiver = null;
      }
      this.chatMeta.clear();
    }
  }

  async send(message: OutgoingMessage): Promise<void> {
    if (this.imessageMode === "bluebubbles") {
      await this.sendBlueBubbles(message);
    } else {
      await this.sendChatDb(message);
    }
  }

  private async sendChatDb(message: OutgoingMessage): Promise<void> {
    const meta = this.chatMeta.get(message.channelId);
    if (!meta) {
      console.warn(`[imessage-adapter] No cached metadata for ${message.channelId}, cannot send`);
      return;
    }

    const target = meta.chatStyle === STYLE_GROUP ? meta.chatGuid : meta.handleIdentifier;

    const chunks = chunk(message.content);
    for (const text of chunks) {
      try {
        await sendIMessage(target, text);
      } catch (err) {
        console.error("[imessage-adapter] Send failed:", err);
      }
    }
  }

  private async sendBlueBubbles(message: OutgoingMessage): Promise<void> {
    if (!this.bbAdapter) {
      console.warn("[imessage-adapter] BlueBubbles adapter not initialized");
      return;
    }

    // Resolve chat GUID — BlueBubbles needs the full GUID
    let chatGuid = this.bbChatGuids.get(message.channelId);
    if (!chatGuid) {
      // For 1:1 chats, construct the GUID from the handle
      chatGuid = `iMessage;-;${message.channelId}`;
    }

    try {
      await this.bbAdapter.sendMessage(chatGuid, message.content);
    } catch (err) {
      console.error("[imessage-adapter] BlueBubbles send failed:", err);
    }
  }
}
