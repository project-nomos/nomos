/**
 * Per-session FIFO message queue with serialized processing.
 *
 * Ensures no concurrent agent runs on the same conversation.
 * Messages for the same session key are processed sequentially;
 * messages for different sessions process concurrently.
 */

import type { IncomingMessage, OutgoingMessage, AgentEvent, MessageHandler } from "./types.ts";

interface QueueEntry {
  message: IncomingMessage;
  resolve: (result: OutgoingMessage) => void;
  reject: (error: Error) => void;
  emit: (event: AgentEvent) => void;
}

export class MessageQueue {
  private queues = new Map<string, QueueEntry[]>();
  private processing = new Set<string>();
  private handler: MessageHandler;

  constructor(handler: MessageHandler) {
    this.handler = handler;
  }

  /**
   * Enqueue a message for processing.
   * Returns a promise that resolves with the outgoing message.
   */
  enqueue(
    sessionKey: string,
    message: IncomingMessage,
    emit: (event: AgentEvent) => void,
  ): Promise<OutgoingMessage> {
    return new Promise<OutgoingMessage>((resolve, reject) => {
      let queue = this.queues.get(sessionKey);
      if (!queue) {
        queue = [];
        this.queues.set(sessionKey, queue);
      }

      queue.push({ message, resolve, reject, emit });

      // Start processing if not already
      if (!this.processing.has(sessionKey)) {
        this.processQueue(sessionKey);
      }
    });
  }

  /** Number of sessions with pending messages. */
  get pendingSessionCount(): number {
    return this.queues.size;
  }

  /** Total pending messages across all sessions. */
  get pendingMessageCount(): number {
    let count = 0;
    for (const queue of this.queues.values()) {
      count += queue.length;
    }
    return count;
  }

  private async processQueue(sessionKey: string): Promise<void> {
    if (this.processing.has(sessionKey)) return;
    this.processing.add(sessionKey);

    try {
      while (true) {
        const queue = this.queues.get(sessionKey);
        if (!queue || queue.length === 0) {
          this.queues.delete(sessionKey);
          break;
        }

        const entry = queue.shift()!;

        try {
          const result = await this.handler(entry.message, entry.emit);
          entry.resolve(result);
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          entry.emit({ type: "error", message: error.message });
          entry.reject(error);
        }
      }
    } finally {
      this.processing.delete(sessionKey);
    }
  }
}
