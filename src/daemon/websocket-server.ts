/**
 * WebSocket server for terminal UI clients.
 *
 * Accepts connections, parses client messages, dispatches to the message queue,
 * and streams agent events back to clients.
 */

import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage as HttpRequest } from "node:http";
import type { MessageQueue } from "./message-queue.ts";
import type { DraftManager } from "./draft-manager.ts";
import type { ClientMessage, AgentEvent, IncomingMessage } from "./types.ts";
import { createLogger } from "../lib/logger.ts";

const log = createLogger("websocket-server");

const HEARTBEAT_INTERVAL_MS = 30_000;

interface ConnectedClient {
  id: string;
  ws: WebSocket;
  alive: boolean;
}

export class DaemonWebSocketServer {
  private wss: WebSocketServer | null = null;
  private clients = new Map<string, ConnectedClient>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private messageQueue: MessageQueue;
  private draftManager: DraftManager | null;
  private port: number;

  constructor(messageQueue: MessageQueue, port: number = 8765, draftManager?: DraftManager) {
    this.messageQueue = messageQueue;
    this.draftManager = draftManager ?? null;
    this.port = port;
  }

  /** Start listening for WebSocket connections. */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.wss = new WebSocketServer({ port: this.port });

      this.wss.on("listening", () => {
        log.info(`Listening on ws://localhost:${this.port}`);
        resolve();
      });

      this.wss.on("error", (err) => {
        log.error({ err }, "Server error");
        reject(err);
      });

      this.wss.on("connection", (ws, req) => {
        this.handleConnection(ws, req);
      });

      // Heartbeat to detect dead connections
      this.heartbeatTimer = setInterval(() => {
        for (const client of this.clients.values()) {
          if (!client.alive) {
            log.info(`Client ${client.id} timed out`);
            client.ws.terminate();
            this.clients.delete(client.id);
            continue;
          }
          client.alive = false;
          client.ws.ping();
        }
      }, HEARTBEAT_INTERVAL_MS);
    });
  }

  /** Stop the WebSocket server. */
  async stop(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    // Close all client connections
    for (const client of this.clients.values()) {
      client.ws.close(1001, "Server shutting down");
    }
    this.clients.clear();

    return new Promise<void>((resolve) => {
      if (!this.wss) {
        resolve();
        return;
      }
      this.wss.close(() => {
        this.wss = null;
        resolve();
      });
    });
  }

  /** Number of connected clients. */
  get clientCount(): number {
    return this.clients.size;
  }

  /** Broadcast an event to all connected clients. */
  broadcast(event: AgentEvent): void {
    const data = JSON.stringify(event);
    for (const client of this.clients.values()) {
      if (client.ws.readyState === WebSocket.OPEN) {
        try {
          client.ws.send(data);
        } catch (err) {
          log.error({ err }, `Failed to broadcast to client ${client.id}`);
        }
      }
    }
  }

  /** Send an event to a specific client. */
  private sendToClient(clientId: string, event: AgentEvent): void {
    const client = this.clients.get(clientId);
    if (!client || client.ws.readyState !== WebSocket.OPEN) return;

    try {
      client.ws.send(JSON.stringify(event));
    } catch (err) {
      log.error({ err }, `Failed to send to client ${clientId}`);
    }
  }

  private handleConnection(ws: WebSocket, _req: HttpRequest): void {
    const clientId = randomUUID();
    const client: ConnectedClient = { id: clientId, ws, alive: true };
    this.clients.set(clientId, client);

    log.info(`Client connected: ${clientId}`);

    ws.on("pong", () => {
      client.alive = true;
    });

    ws.on("message", (data) => {
      try {
        const raw = data.toString();
        const msg: ClientMessage = JSON.parse(raw);
        this.handleClientMessage(clientId, msg);
      } catch (err) {
        this.sendToClient(clientId, {
          type: "error",
          message: `Invalid message format: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });

    ws.on("close", () => {
      log.info(`Client disconnected: ${clientId}`);
      this.clients.delete(clientId);
    });

    ws.on("error", (err) => {
      log.error({ err }, `Client ${clientId} error`);
      this.clients.delete(clientId);
    });

    // Send init event
    this.sendToClient(clientId, {
      type: "system",
      subtype: "init",
      message: "Connected to daemon",
    });
  }

  private handleClientMessage(clientId: string, msg: ClientMessage): void {
    switch (msg.type) {
      case "ping": {
        this.sendToClient(clientId, { type: "pong" });
        break;
      }

      case "message": {
        const incoming: IncomingMessage = {
          id: randomUUID(),
          platform: "terminal",
          channelId: msg.sessionKey,
          userId: "cli-user",
          content: msg.content,
          timestamp: new Date(),
        };

        const emit = (event: AgentEvent) => {
          this.sendToClient(clientId, event);
        };

        this.messageQueue.enqueue(msg.sessionKey, incoming, emit).catch((err) => {
          this.sendToClient(clientId, {
            type: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        });
        break;
      }

      case "command": {
        // Commands like /compact handled by emitting a system message
        this.sendToClient(clientId, {
          type: "system",
          subtype: "command_ack",
          message: `Command received: ${msg.command}`,
        });
        break;
      }

      case "approve_draft": {
        if (!this.draftManager) {
          this.sendToClient(clientId, { type: "error", message: "Draft manager not available" });
          break;
        }
        this.draftManager.approve(msg.draftId).then((result) => {
          this.sendToClient(clientId, {
            type: "system",
            subtype: result.success ? "draft_approved" : "draft_error",
            message: result.success
              ? `Draft ${msg.draftId.slice(0, 8)} approved and sent`
              : `Draft approval failed: ${result.error}`,
          });
        });
        break;
      }

      case "reject_draft": {
        if (!this.draftManager) {
          this.sendToClient(clientId, { type: "error", message: "Draft manager not available" });
          break;
        }
        this.draftManager.reject(msg.draftId).then((result) => {
          this.sendToClient(clientId, {
            type: "system",
            subtype: result.success ? "draft_rejected" : "draft_error",
            message: result.success
              ? `Draft ${msg.draftId.slice(0, 8)} rejected`
              : `Draft rejection failed: ${result.error}`,
          });
        });
        break;
      }
    }
  }
}
