/**
 * Defines how SDK sessions are scoped across different messaging platforms.
 */

/**
 * Determines how sessions are keyed per integration.
 * - "channel": One session per channel (current default, backward compatible)
 * - "sender": One session per user within a channel
 * - "peer": One session per user globally across all channels
 * - "channel-peer": One session per user per channel (most granular)
 */
export type ScopeMode = "channel" | "sender" | "peer" | "channel-peer";

/**
 * Represents the identity context for a session.
 * Used to build session keys based on the active scope mode.
 */
export interface SessionScope {
  /** Platform identifier (e.g., "discord", "slack", "telegram", "whatsapp") */
  platform: string;
  /** Channel/chat identifier (required for channel-based scopes) */
  channelId?: string;
  /** User identifier (required for user-based scopes) */
  userId?: string;
  /** Thread identifier (optional, for platforms that support threading) */
  threadId?: string;
}
