/**
 * Shared types for the daemon subsystem.
 */

import type { SDKMessage } from "../sdk/session.ts";

// ── Incoming messages (from channels/UI → agent runtime) ──

export interface IncomingMessage {
  /** Unique message ID */
  id: string;
  /** Source platform */
  platform: string;
  /** Channel or chat identifier */
  channelId: string;
  /** User identifier */
  userId: string;
  /** Thread identifier (if applicable) */
  threadId?: string;
  /** Message text content */
  content: string;
  /** Timestamp */
  timestamp: Date;
  /** Metadata (platform-specific extras) */
  metadata?: Record<string, unknown>;
}

// ── Outgoing messages (agent runtime → channels/UI) ──

export interface OutgoingMessage {
  /** Correlating incoming message ID */
  inReplyTo: string;
  /** Target platform */
  platform: string;
  /** Target channel or chat */
  channelId: string;
  /** Thread identifier (if applicable) */
  threadId?: string;
  /** Full response text */
  content: string;
  /** SDK session ID for resume */
  sessionId?: string;
}

// ── Agent events (streamed to WebSocket clients) ──

export type AgentEvent =
  | { type: "stream_event"; event: SDKMessage }
  | { type: "tool_use_summary"; tool_name: string; summary?: string }
  | {
      type: "result";
      result: unknown[];
      usage: { input_tokens: number; output_tokens: number };
      total_cost_usd: number;
      session_id?: string;
    }
  | { type: "system"; subtype: string; message: string; data?: Record<string, unknown> }
  | { type: "error"; message: string }
  | { type: "pong" };

// ── WebSocket protocol ──

export type ClientMessage =
  | { type: "message"; content: string; sessionKey: string }
  | { type: "command"; command: string; sessionKey: string }
  | { type: "approve_draft"; draftId: string }
  | { type: "reject_draft"; draftId: string }
  | { type: "ping" };

// ── Channel adapter interface ──

export interface ChannelAdapter {
  /** Platform name (e.g., "slack", "discord") */
  readonly platform: string;

  /** Start the adapter (connect to platform API) */
  start(): Promise<void>;

  /** Stop the adapter (disconnect gracefully) */
  stop(): Promise<void>;

  /** Send a message back to the platform */
  send(message: OutgoingMessage): Promise<void>;

  /** Post a message, return its ID for later updates */
  postMessage?(channelId: string, text: string, threadId?: string): Promise<string | undefined>;

  /** Update a previously posted message */
  updateMessage?(channelId: string, messageId: string, text: string): Promise<void>;

  /** Delete a previously posted message */
  deleteMessage?(channelId: string, messageId: string): Promise<void>;
}

// ── Message handler callback ──

export type MessageHandler = (
  message: IncomingMessage,
  emit: (event: AgentEvent) => void,
) => Promise<OutgoingMessage>;
