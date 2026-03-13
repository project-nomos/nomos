/**
 * Thin iMessage channel adapter for the daemon.
 *
 * macOS only. Reads incoming messages from ~/Library/Messages/chat.db
 * and sends replies via AppleScript (osascript).
 */

import { randomUUID } from "node:crypto";
import { IMessageReceiver } from "./imessage-receiver.ts";
import { sendIMessage } from "./imessage-sender.ts";
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

interface ChatMeta {
  chatGuid: string;
  chatStyle: number;
  handleIdentifier: string;
}

export class IMessageAdapter implements ChannelAdapter {
  readonly platform = "imessage";
  private receiver: IMessageReceiver | null = null;
  private onMessage: (msg: IncomingMessage) => void;
  /** Cache chat metadata for send routing. Key = chatIdentifier. */
  private chatMeta = new Map<string, ChatMeta>();

  constructor(onMessage: (msg: IncomingMessage) => void) {
    this.onMessage = onMessage;
  }

  async start(): Promise<void> {
    if (process.platform !== "darwin") {
      throw new Error("iMessage adapter requires macOS");
    }

    const allowedChats = process.env.IMESSAGE_ALLOWED_CHATS
      ? new Set(process.env.IMESSAGE_ALLOWED_CHATS.split(",").map((s) => s.trim()))
      : null;

    this.receiver = new IMessageReceiver((msg) => {
      // Check allowlist against both handle and chat identifier
      if (allowedChats) {
        const allowed =
          allowedChats.has(msg.handleIdentifier) || allowedChats.has(msg.chatIdentifier);
        if (!allowed) return;
      }

      // Cache metadata for send routing
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
    console.log("[imessage-adapter] Started — watching for incoming messages");
  }

  async stop(): Promise<void> {
    if (this.receiver) {
      this.receiver.stop();
      this.receiver = null;
    }
    this.chatMeta.clear();
  }

  async send(message: OutgoingMessage): Promise<void> {
    const meta = this.chatMeta.get(message.channelId);
    if (!meta) {
      console.warn(`[imessage-adapter] No cached metadata for ${message.channelId}, cannot send`);
      return;
    }

    // For 1:1 chats, send to the handle directly.
    // For group chats, send via the chat GUID.
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
}
