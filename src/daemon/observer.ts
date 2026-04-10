/**
 * Observation pipeline.
 *
 * Receives messages in observe mode (passive learning) —
 * indexes them into memory without triggering agent responses.
 * Used for learning from Slack channel conversations the user
 * can see but wasn't directly involved in.
 */

import { indexConversationTurn } from "./memory-indexer.ts";
import type { IncomingMessage, OutgoingMessage } from "./types.ts";

/**
 * Process an observed message — store in memory without agent response.
 *
 * The message is indexed like a regular conversation turn but with
 * a synthetic empty outgoing message (no agent response).
 */
export async function observeMessage(message: IncomingMessage): Promise<void> {
  // Create a synthetic "no response" outgoing to satisfy indexer interface
  const syntheticOutgoing: OutgoingMessage = {
    inReplyTo: message.id,
    platform: message.platform,
    channelId: message.channelId,
    threadId: message.threadId,
    content: "", // Empty — we're just observing
  };

  try {
    await indexConversationTurn(message, syntheticOutgoing);
  } catch (err) {
    console.warn(
      `[observer] Failed to index observed message from ${message.platform}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Process a batch of observed messages.
 */
export async function observeMessages(messages: IncomingMessage[]): Promise<number> {
  let indexed = 0;
  for (const msg of messages) {
    await observeMessage(msg);
    indexed++;
  }
  return indexed;
}
