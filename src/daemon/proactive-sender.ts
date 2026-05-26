/**
 * Proactive message sender.
 *
 * Allows the agent to send messages to channels without being prompted.
 * Uses the default notification channel or a specific target.
 * Integrates with channel adapters for delivery.
 */

import type { ChannelManager } from "./channel-manager.ts";
import { createLogger } from "../lib/logger.ts";

const log = createLogger("proactive-sender");

export interface ProactiveMessage {
  /** Target platform (e.g., "slack-user:T074HACEZ2L") */
  platform: string;
  /** Target channel/user ID */
  channelId: string;
  /** Message content */
  content: string;
  /** Optional thread ID */
  threadId?: string;
}

/**
 * Send a proactive message through a channel adapter.
 * Returns true if delivered, false if no adapter found.
 */
export async function sendProactiveMessage(
  channelManager: ChannelManager,
  message: ProactiveMessage,
): Promise<boolean> {
  const adapter = channelManager.getAdapter(message.platform);
  if (!adapter) {
    log.warn(`No adapter for platform: ${message.platform}`);
    return false;
  }

  try {
    if (adapter.postMessage) {
      await adapter.postMessage(message.channelId, message.content, message.threadId);
    } else {
      await adapter.send({
        inReplyTo: "proactive",
        platform: message.platform,
        channelId: message.channelId,
        threadId: message.threadId,
        content: message.content,
      });
    }
    log.info(
      `Message sent to ${message.platform}/${message.channelId} (${message.content.length} chars)`,
    );
    return true;
  } catch (err) {
    log.error({ err }, "Failed to send message");
    return false;
  }
}

/**
 * Resolve the default notification target.
 * Returns null if no default is configured.
 */
export async function resolveDefaultTarget(): Promise<{
  platform: string;
  channelId: string;
  label?: string;
} | null> {
  try {
    const { getNotificationDefault } = await import("../db/notification-defaults.ts");
    return getNotificationDefault();
  } catch {
    return null;
  }
}
