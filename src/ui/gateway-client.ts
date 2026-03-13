/**
 * WebSocket client for connecting the terminal UI to the daemon.
 *
 * Provides the same interface as direct `runSession()` calls:
 * send a message, receive a stream of events.
 */

import WebSocket from "ws";
import type { ClientMessage, AgentEvent } from "../daemon/types.ts";

export type ConnectionState = "connecting" | "connected" | "disconnected" | "reconnecting";

export interface GatewayClientOptions {
  /** WebSocket URL (default: ws://localhost:8765) */
  url?: string;
  /** Auto-reconnect on disconnect */
  autoReconnect?: boolean;
  /** Max reconnect attempts */
  maxReconnectAttempts?: number;
  /** Reconnect delay in ms (doubles each attempt) */
  reconnectDelayMs?: number;
}

export class GatewayClient {
  private ws: WebSocket | null = null;
  private url: string;
  private autoReconnect: boolean;
  private maxReconnectAttempts: number;
  private reconnectDelayMs: number;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private state: ConnectionState = "disconnected";
  private onStateChange?: (state: ConnectionState) => void;
  private eventListeners = new Set<(event: AgentEvent) => void>();
  private pendingResolvers = new Map<string, () => void>();

  constructor(options: GatewayClientOptions = {}) {
    this.url = options.url ?? "ws://localhost:8765";
    this.autoReconnect = options.autoReconnect ?? true;
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? 10;
    this.reconnectDelayMs = options.reconnectDelayMs ?? 1000;
  }

  /** Current connection state. */
  getState(): ConnectionState {
    return this.state;
  }

  /** Set state change handler. */
  onConnectionStateChange(handler: (state: ConnectionState) => void): void {
    this.onStateChange = handler;
  }

  /** Add an event listener. */
  onEvent(handler: (event: AgentEvent) => void): () => void {
    this.eventListeners.add(handler);
    return () => this.eventListeners.delete(handler);
  }

  /** Connect to the daemon. */
  connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.setState("connecting");

      this.ws = new WebSocket(this.url);

      this.ws.on("open", () => {
        this.setState("connected");
        this.reconnectAttempts = 0;
        resolve();
      });

      this.ws.on("message", (data) => {
        try {
          const event: AgentEvent = JSON.parse(data.toString());
          for (const listener of this.eventListeners) {
            listener(event);
          }
        } catch {
          // Ignore malformed messages
        }
      });

      this.ws.on("close", () => {
        this.setState("disconnected");
        this.ws = null;
        if (this.autoReconnect) {
          this.scheduleReconnect();
        }
      });

      this.ws.on("error", (err) => {
        if (this.state === "connecting") {
          reject(err);
        }
      });
    });
  }

  /** Disconnect from the daemon. */
  disconnect(): void {
    this.autoReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.setState("disconnected");
  }

  /** Send a message to the daemon for processing. */
  sendMessage(content: string, sessionKey: string): void {
    const msg: ClientMessage = { type: "message", content, sessionKey };
    this.send(msg);
  }

  /** Send a command (e.g., /compact). */
  sendCommand(command: string, sessionKey: string): void {
    const msg: ClientMessage = { type: "command", command, sessionKey };
    this.send(msg);
  }

  /** Send a ping. */
  ping(): void {
    this.send({ type: "ping" });
  }

  /** Check if the daemon is reachable. */
  async isDaemonReachable(): Promise<boolean> {
    return new Promise((resolve) => {
      const ws = new WebSocket(this.url);
      const timeout = setTimeout(() => {
        ws.terminate();
        resolve(false);
      }, 2000);

      ws.on("open", () => {
        clearTimeout(timeout);
        ws.close();
        resolve(true);
      });

      ws.on("error", () => {
        clearTimeout(timeout);
        resolve(false);
      });
    });
  }

  private send(msg: ClientMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Not connected to daemon");
    }
    this.ws.send(JSON.stringify(msg));
  }

  private setState(state: ConnectionState): void {
    this.state = state;
    this.onStateChange?.(state);
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error("[gateway-client] Max reconnect attempts reached");
      return;
    }

    const delay = this.reconnectDelayMs * Math.pow(2, this.reconnectAttempts);
    this.reconnectAttempts++;
    this.setState("reconnecting");

    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.connect();
      } catch {
        // Will trigger another reconnect via close handler
      }
    }, delay);
  }
}
