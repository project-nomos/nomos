/**
 * gRPC client for connecting the terminal UI to the daemon.
 *
 * Provides the same interface as GatewayClient (WebSocket):
 * send a message, receive a stream of events.
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import type { AgentEvent } from "../daemon/types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = resolve(__dirname, "../../proto/nomos.proto");

export type ConnectionState = "connecting" | "connected" | "disconnected" | "reconnecting";

export interface GrpcClientOptions {
  /** gRPC host (default: localhost) */
  host?: string;
  /** gRPC port (default: 8766) */
  port?: number;
  /** Auto-reconnect on disconnect */
  autoReconnect?: boolean;
  /** Max reconnect attempts */
  maxReconnectAttempts?: number;
  /** Reconnect delay in ms (doubles each attempt) */
  reconnectDelayMs?: number;
}

export class GrpcClient {
  private client: Record<string, (...args: unknown[]) => unknown> | null = null;
  private host: string;
  private port: number;
  private autoReconnect: boolean;
  private maxReconnectAttempts: number;
  private reconnectDelayMs: number;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private state: ConnectionState = "disconnected";
  private onStateChange?: (state: ConnectionState) => void;
  private eventListeners = new Set<(event: AgentEvent) => void>();
  private packageDefinition: protoLoader.PackageDefinition | null = null;

  constructor(options: GrpcClientOptions = {}) {
    this.host = options.host ?? "localhost";
    this.port = options.port ?? 8766;
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

  /** Add an event listener. Returns an unsubscribe function. */
  onEvent(handler: (event: AgentEvent) => void): () => void {
    this.eventListeners.add(handler);
    return () => this.eventListeners.delete(handler);
  }

  /** Connect to the daemon gRPC server. */
  connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.setState("connecting");

      try {
        if (!this.packageDefinition) {
          this.packageDefinition = protoLoader.loadSync(PROTO_PATH, {
            keepCase: false,
            longs: String,
            enums: String,
            defaults: true,
            oneofs: true,
          });
        }

        const protoDescriptor = grpc.loadPackageDefinition(this.packageDefinition);
        const nomosPackage = protoDescriptor.nomos as Record<string, unknown>;
        const NomosAgentClient = nomosPackage.NomosAgent as new (
          address: string,
          credentials: grpc.ChannelCredentials,
        ) => Record<string, (...args: unknown[]) => unknown>;

        const address = `${this.host}:${this.port}`;
        this.client = new NomosAgentClient(address, grpc.credentials.createInsecure());

        // Verify connection with a Ping
        (this.client.ping as (
          req: Record<string, never>,
          callback: (err: grpc.ServiceError | null, resp: unknown) => void,
        ) => void)({}, (err: grpc.ServiceError | null) => {
          if (err) {
            this.client = null;
            this.setState("disconnected");
            reject(err);
            return;
          }
          this.setState("connected");
          this.reconnectAttempts = 0;
          resolve();
        });
      } catch (err) {
        this.setState("disconnected");
        reject(err);
      }
    });
  }

  /** Disconnect from the daemon. */
  disconnect(): void {
    this.autoReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.client) {
      const channel = this.client as unknown as { close?: () => void };
      channel.close?.();
      this.client = null;
    }
    this.setState("disconnected");
  }

  /** Send a message to the daemon for processing. Streams events to listeners. */
  sendMessage(content: string, sessionKey: string): void {
    if (!this.client) {
      throw new Error("Not connected to daemon");
    }

    const chatFn = this.client.chat as (
      req: { content: string; sessionKey: string },
    ) => grpc.ClientReadableStream<{ type: string; jsonPayload: string }>;

    const stream = chatFn.call(this.client, { content, sessionKey });

    stream.on("data", (data: { type: string; jsonPayload: string }) => {
      try {
        const payload = data.jsonPayload ? JSON.parse(data.jsonPayload) : {};
        const event: AgentEvent = { type: data.type, ...payload } as AgentEvent;
        for (const listener of this.eventListeners) {
          listener(event);
        }
      } catch {
        // Ignore malformed events
      }
    });

    stream.on("error", (err: grpc.ServiceError) => {
      // CANCELLED is normal when stream ends
      if (err.code === grpc.status.CANCELLED) return;

      const errorEvent: AgentEvent = {
        type: "error",
        message: err.details || err.message,
      };
      for (const listener of this.eventListeners) {
        listener(errorEvent);
      }

      if (this.autoReconnect) {
        this.setState("disconnected");
        this.scheduleReconnect();
      }
    });

    stream.on("end", () => {
      // Stream completed normally
    });
  }

  /** Send a command (e.g., /compact). */
  sendCommand(command: string, sessionKey: string): void {
    if (!this.client) {
      throw new Error("Not connected to daemon");
    }

    const commandFn = this.client.command as (
      req: { command: string; sessionKey: string },
      callback: (err: grpc.ServiceError | null, resp: { success: boolean; message: string }) => void,
    ) => void;

    commandFn.call(this.client, { command, sessionKey }, (err, resp) => {
      if (err) {
        for (const listener of this.eventListeners) {
          listener({ type: "error", message: err.details || err.message });
        }
        return;
      }
      for (const listener of this.eventListeners) {
        listener({
          type: "system",
          subtype: "command_ack",
          message: resp.message,
        });
      }
    });
  }

  /** Send a ping. */
  ping(): void {
    if (!this.client) return;

    const pingFn = this.client.ping as (
      req: Record<string, never>,
      callback: (err: grpc.ServiceError | null) => void,
    ) => void;

    pingFn.call(this.client, {}, (err) => {
      if (!err) {
        for (const listener of this.eventListeners) {
          listener({ type: "pong" });
        }
      }
    });
  }

  /** Check if the daemon is reachable via gRPC. */
  async isDaemonReachable(): Promise<boolean> {
    return new Promise((resolve) => {
      try {
        if (!this.packageDefinition) {
          this.packageDefinition = protoLoader.loadSync(PROTO_PATH, {
            keepCase: false,
            longs: String,
            enums: String,
            defaults: true,
            oneofs: true,
          });
        }

        const protoDescriptor = grpc.loadPackageDefinition(this.packageDefinition);
        const nomosPackage = protoDescriptor.nomos as Record<string, unknown>;
        const NomosAgentClient = nomosPackage.NomosAgent as new (
          address: string,
          credentials: grpc.ChannelCredentials,
        ) => Record<string, (...args: unknown[]) => unknown>;

        const address = `${this.host}:${this.port}`;
        const tempClient = new NomosAgentClient(address, grpc.credentials.createInsecure());

        const deadline = new Date();
        deadline.setSeconds(deadline.getSeconds() + 2);

        const pingFn = tempClient.ping as (
          req: Record<string, never>,
          metadata: grpc.Metadata,
          options: { deadline: Date },
          callback: (err: grpc.ServiceError | null) => void,
        ) => void;

        pingFn.call(tempClient, {}, new grpc.Metadata(), { deadline }, (err) => {
          const channel = tempClient as unknown as { close?: () => void };
          channel.close?.();
          resolve(!err);
        });
      } catch {
        resolve(false);
      }
    });
  }

  private setState(state: ConnectionState): void {
    this.state = state;
    this.onStateChange?.(state);
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error("[grpc-client] Max reconnect attempts reached");
      return;
    }

    const delay = this.reconnectDelayMs * Math.pow(2, this.reconnectAttempts);
    this.reconnectAttempts++;
    this.setState("reconnecting");

    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.connect();
      } catch {
        // Will trigger another reconnect attempt
      }
    }, delay);
  }
}
