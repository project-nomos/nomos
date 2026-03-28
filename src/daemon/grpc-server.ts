/**
 * gRPC server for terminal UI clients.
 *
 * Runs alongside the WebSocket server, accepting gRPC connections.
 * Parses client requests, dispatches to the message queue,
 * and streams agent events back to clients.
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import type { MessageQueue } from "./message-queue.ts";
import type { DraftManager } from "./draft-manager.ts";
import type { AgentEvent, IncomingMessage } from "./types.ts";
import { indexConversationTurn } from "./memory-indexer.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
// In dev (tsx): __dirname = src/daemon/ → ../../proto works
// In built (dist/): __dirname = dist/ → ../proto works
// Try both paths and use whichever exists
const PROTO_PATH = existsSync(resolve(__dirname, "../../proto/nomos.proto"))
  ? resolve(__dirname, "../../proto/nomos.proto")
  : resolve(__dirname, "../proto/nomos.proto");

/** Active server-streaming call for broadcasting events. */
interface ActiveStream {
  id: string;
  call: grpc.ServerWritableStream<unknown, unknown>;
}

export class GrpcServer {
  private server: grpc.Server | null = null;
  private activeStreams = new Map<string, ActiveStream>();
  private messageQueue: MessageQueue;
  private draftManager: DraftManager | null;
  private port: number;
  private commandHandler?: (command: string) => Promise<string>;

  constructor(messageQueue: MessageQueue, port: number = 8766, draftManager?: DraftManager) {
    this.messageQueue = messageQueue;
    this.draftManager = draftManager ?? null;
    this.port = port;
  }

  /** Register a handler for Command RPCs. */
  onCommand(handler: (command: string) => Promise<string>): void {
    this.commandHandler = handler;
  }

  /** Start listening for gRPC connections. */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
        keepCase: false,
        longs: String,
        enums: String,
        defaults: true,
        oneofs: true,
      });

      const protoDescriptor = grpc.loadPackageDefinition(packageDefinition);
      const nomosPackage = protoDescriptor.nomos as Record<string, unknown>;
      const NomosAgentService = (nomosPackage.NomosAgent as { service: grpc.ServiceDefinition })
        .service;

      this.server = new grpc.Server();
      this.server.addService(NomosAgentService, {
        Chat: this.handleChat.bind(this),
        Command: this.handleCommand.bind(this),
        GetStatus: this.handleGetStatus.bind(this),
        ListSessions: this.handleListSessions.bind(this),
        GetSession: this.handleGetSession.bind(this),
        ListDrafts: this.handleListDrafts.bind(this),
        ApproveDraft: this.handleApproveDraft.bind(this),
        RejectDraft: this.handleRejectDraft.bind(this),
        Ping: this.handlePing.bind(this),
      });

      this.server.bindAsync(
        `0.0.0.0:${this.port}`,
        grpc.ServerCredentials.createInsecure(),
        (err, boundPort) => {
          if (err) {
            console.error("[grpc-server] Failed to bind:", err);
            reject(err);
            return;
          }
          console.log(`[grpc-server] Listening on 0.0.0.0:${boundPort}`);
          resolve();
        },
      );
    });
  }

  /** Stop the gRPC server. */
  async stop(): Promise<void> {
    // End all active streams
    for (const stream of this.activeStreams.values()) {
      try {
        stream.call.end();
      } catch {
        // Stream may already be closed
      }
    }
    this.activeStreams.clear();

    return new Promise<void>((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.tryShutdown(() => {
        this.server = null;
        resolve();
      });
    });
  }

  /** Number of active streaming clients. */
  get clientCount(): number {
    return this.activeStreams.size;
  }

  /** Broadcast an event to all active streaming clients. */
  broadcast(event: AgentEvent): void {
    const payload = this.serializeEvent(event);
    for (const stream of this.activeStreams.values()) {
      try {
        stream.call.write(payload);
      } catch (err) {
        console.error(`[grpc-server] Failed to broadcast to stream ${stream.id}:`, err);
      }
    }
  }

  /** Serialize an AgentEvent into a gRPC AgentEvent message. */
  private serializeEvent(event: AgentEvent): { type: string; jsonPayload: string } {
    const { type, ...rest } = event;
    return {
      type,
      jsonPayload: JSON.stringify(rest),
    };
  }

  /** Handle Chat RPC: server-streaming of agent events. */
  private handleChat(
    call: grpc.ServerWritableStream<{ content: string; sessionKey: string }, unknown>,
  ): void {
    const streamId = randomUUID();
    const request = call.request;
    const content = request?.content ?? "";
    const sessionKey = request?.sessionKey ?? "cli:default";

    // Register as active stream
    this.activeStreams.set(streamId, { id: streamId, call });

    // Send init event
    call.write(
      this.serializeEvent({
        type: "system",
        subtype: "init",
        message: "Connected to daemon via gRPC",
      }),
    );

    // Create incoming message
    const incoming: IncomingMessage = {
      id: randomUUID(),
      platform: "terminal",
      channelId: sessionKey,
      userId: "cli-user",
      content,
      timestamp: new Date(),
    };

    const emit = (event: AgentEvent) => {
      try {
        call.write(this.serializeEvent(event));
      } catch {
        // Stream may have been cancelled
        this.activeStreams.delete(streamId);
      }
    };

    this.messageQueue
      .enqueue(sessionKey, incoming, emit)
      .then((result) => {
        // Fire-and-forget: index conversation turn into vector memory
        indexConversationTurn(incoming, result).catch((err) =>
          console.error("[grpc-server] Memory indexing failed:", err),
        );
        call.end();
        this.activeStreams.delete(streamId);
      })
      .catch((err) => {
        emit({
          type: "error",
          message: err instanceof Error ? err.message : String(err),
        });
        call.end();
        this.activeStreams.delete(streamId);
      });

    // Clean up if client cancels
    call.on("cancelled", () => {
      this.activeStreams.delete(streamId);
    });
  }

  /** Handle Command RPC. */
  private handleCommand(
    call: grpc.ServerUnaryCall<{ command: string; sessionKey: string }, unknown>,
    callback: grpc.sendUnaryData<{ success: boolean; message: string }>,
  ): void {
    const command = call.request?.command ?? "";
    if (this.commandHandler) {
      this.commandHandler(command)
        .then((message) => callback(null, { success: true, message }))
        .catch((err) => callback(null, { success: false, message: String(err) }));
    } else {
      callback(null, { success: true, message: `Command received: ${command}` });
    }
  }

  /** Handle GetStatus RPC. */
  private handleGetStatus(
    _call: grpc.ServerUnaryCall<unknown, unknown>,
    callback: grpc.sendUnaryData<{
      running: boolean;
      connectedClients: number;
      platforms: string[];
    }>,
  ): void {
    callback(null, {
      running: true,
      connectedClients: this.activeStreams.size,
      platforms: [],
    });
  }

  /** Handle ListSessions RPC. */
  private handleListSessions(
    _call: grpc.ServerUnaryCall<unknown, unknown>,
    callback: grpc.sendUnaryData<{ sessions: unknown[] }>,
  ): void {
    // Return empty for now; can be wired to DB later
    callback(null, { sessions: [] });
  }

  /** Handle GetSession RPC. */
  private handleGetSession(
    _call: grpc.ServerUnaryCall<{ sessionKey: string }, unknown>,
    callback: grpc.sendUnaryData<unknown>,
  ): void {
    callback({
      code: grpc.status.UNIMPLEMENTED,
      details: "GetSession not yet implemented",
    });
  }

  /** Handle ListDrafts RPC. */
  private handleListDrafts(
    _call: grpc.ServerUnaryCall<unknown, unknown>,
    callback: grpc.sendUnaryData<{ drafts: unknown[] }>,
  ): void {
    callback(null, { drafts: [] });
  }

  /** Handle ApproveDraft RPC. */
  private handleApproveDraft(
    call: grpc.ServerUnaryCall<{ draftId: string }, unknown>,
    callback: grpc.sendUnaryData<{ success: boolean; message: string }>,
  ): void {
    const draftId = call.request?.draftId ?? "";
    if (!this.draftManager) {
      callback(null, { success: false, message: "Draft manager not available" });
      return;
    }
    this.draftManager
      .approve(draftId)
      .then((result) => {
        callback(null, {
          success: result.success,
          message: result.success
            ? `Draft ${draftId.slice(0, 8)} approved and sent`
            : `Draft approval failed: ${result.error}`,
        });
      })
      .catch((err) => {
        callback(null, {
          success: false,
          message: err instanceof Error ? err.message : String(err),
        });
      });
  }

  /** Handle RejectDraft RPC. */
  private handleRejectDraft(
    call: grpc.ServerUnaryCall<{ draftId: string }, unknown>,
    callback: grpc.sendUnaryData<{ success: boolean; message: string }>,
  ): void {
    const draftId = call.request?.draftId ?? "";
    if (!this.draftManager) {
      callback(null, { success: false, message: "Draft manager not available" });
      return;
    }
    this.draftManager
      .reject(draftId)
      .then((result) => {
        callback(null, {
          success: result.success,
          message: result.success
            ? `Draft ${draftId.slice(0, 8)} rejected`
            : `Draft rejection failed: ${result.error}`,
        });
      })
      .catch((err) => {
        callback(null, {
          success: false,
          message: err instanceof Error ? err.message : String(err),
        });
      });
  }

  /** Handle Ping RPC. */
  private handlePing(
    _call: grpc.ServerUnaryCall<unknown, unknown>,
    callback: grpc.sendUnaryData<{ timestamp: string }>,
  ): void {
    callback(null, { timestamp: String(Date.now()) });
  }
}
