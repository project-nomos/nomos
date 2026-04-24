/**
 * MessageBatcher: debounces rapid sequential messages from the same sender.
 *
 * Users often send multiple short messages instead of one long message.
 * Without batching, the agent processes each line individually, creating
 * multiple drafts. This class collects messages from the same sender+channel
 * within a time window, then combines them into a single message.
 *
 * The debounce timer resets with each new message. After the window expires
 * with no new messages, all buffered messages are combined and forwarded.
 */

import type { IncomingMessage } from "./types.ts";
import { randomUUID } from "node:crypto";

/** Default debounce window: 8 seconds of silence before processing. */
const DEFAULT_DEBOUNCE_MS = 8_000;

/** Maximum wait time: process after this long even if messages keep arriving. */
const MAX_WAIT_MS = 30_000;

interface BufferEntry {
  messages: IncomingMessage[];
  timer: ReturnType<typeof setTimeout>;
  firstReceivedAt: number;
}

export class MessageBatcher {
  private buffers = new Map<string, BufferEntry>();
  private debounceMs: number;
  private onReady: (combined: IncomingMessage) => void;

  constructor(options: {
    /** Called when a batch is ready (debounce expired or max wait reached). */
    onReady: (combined: IncomingMessage) => void;
    /** Debounce window in ms. Default: 8000. */
    debounceMs?: number;
  }) {
    this.onReady = options.onReady;
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  }

  /**
   * Add a message to the buffer. If no more messages arrive within the
   * debounce window, all buffered messages from this sender+channel are
   * combined and forwarded via the onReady callback.
   */
  add(msg: IncomingMessage): void {
    const key = `${msg.platform}:${msg.channelId}:${msg.userId}`;
    const existing = this.buffers.get(key);

    if (existing) {
      // Add to existing buffer, reset debounce timer
      clearTimeout(existing.timer);
      existing.messages.push(msg);

      // Check max wait -- if we've been buffering too long, flush now
      const elapsed = Date.now() - existing.firstReceivedAt;
      if (elapsed >= MAX_WAIT_MS) {
        this.flush(key);
        return;
      }

      existing.timer = setTimeout(() => this.flush(key), this.debounceMs);
    } else {
      // Start new buffer
      const timer = setTimeout(() => this.flush(key), this.debounceMs);
      this.buffers.set(key, {
        messages: [msg],
        timer,
        firstReceivedAt: Date.now(),
      });
    }
  }

  /** Immediately flush all pending buffers (e.g., on shutdown). */
  flushAll(): void {
    for (const key of [...this.buffers.keys()]) {
      this.flush(key);
    }
  }

  /** Number of active buffer entries. */
  get pendingCount(): number {
    return this.buffers.size;
  }

  private flush(key: string): void {
    const entry = this.buffers.get(key);
    if (!entry) return;

    clearTimeout(entry.timer);
    this.buffers.delete(key);

    const messages = entry.messages;
    if (messages.length === 0) return;

    if (messages.length === 1) {
      // Single message -- pass through unchanged
      this.onReady(messages[0]);
      return;
    }

    // Combine multiple messages into one
    const first = messages[0];
    const combined: IncomingMessage = {
      id: randomUUID(),
      platform: first.platform,
      channelId: first.channelId,
      userId: first.userId,
      threadId: first.threadId,
      content: this.combineContent(messages),
      timestamp: first.timestamp,
      metadata: {
        ...first.metadata,
        batchedCount: messages.length,
        batchedMessageIds: messages.map((m) => m.id),
      },
    };

    console.log(
      `[message-batcher] Combined ${messages.length} messages from ${first.userId} in ${first.channelId}`,
    );

    this.onReady(combined);
  }

  /**
   * Combine message contents. If the messages are all short lines (typical
   * chat-style), join with newlines. Preserves the original metadata from
   * the first message (senderName, messageType, etc.).
   */
  private combineContent(messages: IncomingMessage[]): string {
    // Check if messages use the draft framing wrapper
    const first = messages[0];
    const hasDraftFraming = first.content.includes(
      "Draft a response AS ME (the user). I will review and approve before it's sent.",
    );

    if (hasDraftFraming) {
      // Extract the header line (e.g., "[Slack DM from John]")
      // and the footer (draft instructions), combine just the message bodies
      const lines = first.content.split("\n");
      const headerLine = lines[0]; // e.g., "[Slack DM from John]"

      // Extract raw text from each message (strip the draft framing)
      const rawTexts = messages.map((m) => this.extractRawText(m.content));
      const combinedText = rawTexts.join("\n");

      return [
        headerLine,
        "",
        combinedText,
        "",
        "---",
        `(${messages.length} messages combined)`,
        "Draft a response AS ME (the user). I will review and approve before it's sent.",
        "IMPORTANT: Do NOT send this yourself. Just draft the message content.",
        "Also suggest whether to reply in-thread or as a new message.",
      ].join("\n");
    }

    // No draft framing -- just join the raw content
    return messages.map((m) => m.content).join("\n");
  }

  /**
   * Extract the raw message text from a draft-framed message.
   * Strips the header line and footer instructions.
   */
  private extractRawText(content: string): string {
    const lines = content.split("\n");

    // Find the header (starts with "[") and the footer separator "---"
    let startIdx = 0;
    let endIdx = lines.length;

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith("[") && i === 0) {
        // Skip header line and the blank line after it
        startIdx = i + 2;
        continue;
      }
      if (lines[i] === "---") {
        endIdx = i;
        break;
      }
    }

    return lines.slice(startIdx, endIdx).join("\n").trim();
  }
}
