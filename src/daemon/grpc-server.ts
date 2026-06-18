/**
 * gRPC server for terminal UI clients.
 *
 * Runs alongside the WebSocket server, accepting gRPC connections.
 * Parses client requests, dispatches to the message queue,
 * and streams agent events back to clients.
 */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import type { MessageQueue } from "./message-queue.ts";
import type { DraftManager } from "./draft-manager.ts";
import type { AgentEvent, IncomingMessage } from "./types.ts";
import { indexConversationTurn } from "./memory-indexer.ts";
import { depositOAuthCredential } from "./oauth-deposit.ts";
import { buildMobileApiHandlers } from "./mobile-api.ts";
import { createLogger } from "../lib/logger.ts";

const log = createLogger("grpc-server");

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
  private elicitationManager: import("./elicitation-manager.ts").ElicitationManager | null = null;

  constructor(messageQueue: MessageQueue, port: number = 8766, draftManager?: DraftManager) {
    this.messageQueue = messageQueue;
    this.draftManager = draftManager ?? null;
    this.port = port;
  }

  /** Wire in the elicitation manager so AnswerQuestion can resolve pending questions. */
  setElicitationManager(mgr: import("./elicitation-manager.ts").ElicitationManager): void {
    this.elicitationManager = mgr;
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
      const OAuthDepositService = (nomosPackage.OAuthDeposit as { service: grpc.ServiceDefinition })
        .service;
      const MobileApiService = (nomosPackage.MobileApi as { service: grpc.ServiceDefinition })
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
        ListLoops: this.handleListLoops.bind(this),
        SetLoopEnabled: this.handleSetLoopEnabled.bind(this),
        DeleteLoop: this.handleDeleteLoop.bind(this),
        ListTasks: this.handleListTasks.bind(this),
        UpdateTask: this.handleUpdateTask.bind(this),
        DeleteTask: this.handleDeleteTask.bind(this),
        AnswerQuestion: this.handleAnswerQuestion.bind(this),
        Ping: this.handlePing.bind(this),
      });
      this.server.addService(OAuthDepositService, {
        Deposit: depositOAuthCredential,
      });
      this.server.addService(
        MobileApiService,
        buildMobileApiHandlers({
          messageQueue: this.messageQueue,
          draftManager: this.draftManager,
          getElicitationManager: () => this.elicitationManager,
        }) as unknown as grpc.UntypedServiceImplementation,
      );

      const credentials = buildServerCredentials();
      this.server.bindAsync(`0.0.0.0:${this.port}`, credentials, (err, boundPort) => {
        if (err) {
          log.error({ err }, "Failed to bind");
          reject(err);
          return;
        }
        log.info(`Listening on 0.0.0.0:${boundPort}`);
        resolve();
      });
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
        log.error({ err }, `Failed to broadcast to stream ${stream.id}`);
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
    const sessionKey = request?.sessionKey ?? `grpc:${randomUUID()}`;

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
          log.error({ err }, "Memory indexing failed"),
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

  /** Handle ListLoops RPC -- the local owner's autonomous loops + their status. */
  private async handleListLoops(
    _call: grpc.ServerUnaryCall<unknown, unknown>,
    callback: grpc.sendUnaryData<{ loops: unknown[] }>,
  ): Promise<void> {
    try {
      const { CronStore } = await import("../cron/store.ts");
      const { curateConsumerLoops, curateOwnedLoops, MANAGED_LOOPS } =
        await import("../cron/loop-view.ts");
      const { isLoopUserDisabled } = await import("../cron/loop-overrides.ts");
      // Loops = the managed system loops + the agent's own self-authored loops
      // (source 'loop'). The user's scheduled TASKS live on the Tasks surface, so
      // curate rather than dumping every cron_jobs row here.
      const store = new CronStore();
      const system = await store.listJobs({ userId: "local" });
      const owned = await store.listJobs({ userId: "local", source: "loop" });
      const optedOut = new Set<string>();
      for (const j of system) {
        if (MANAGED_LOOPS[j.name] && (await isLoopUserDisabled(j.name))) optedOut.add(j.name);
      }
      callback(null, {
        loops: [...curateConsumerLoops(system, optedOut), ...curateOwnedLoops(owned)],
      });
    } catch (err) {
      callback(err as grpc.ServiceError, null);
    }
  }

  /** Handle SetLoopEnabled RPC -- toggle a loop (never a system infra job). */
  private async handleSetLoopEnabled(
    call: grpc.ServerUnaryCall<{ name: string; enabled: boolean }, unknown>,
    callback: grpc.sendUnaryData<{ success: boolean; message: string }>,
  ): Promise<void> {
    try {
      const { name, enabled } = call.request;
      const { CronStore } = await import("../cron/store.ts");
      const store = new CronStore();
      const job = await store.getJobByName(name);
      if (!job || job.userId !== "local") {
        callback(null, { success: false, message: "loop_not_found" });
        return;
      }
      if (job.source === "system") {
        callback(null, { success: false, message: "system_job_read_only" });
        return;
      }
      await store.updateJob(job.id, { enabled: Boolean(enabled) });
      process.emit("cron:refresh" as never);
      callback(null, { success: true, message: enabled ? "enabled" : "disabled" });
    } catch (err) {
      callback(err as grpc.ServiceError, null);
    }
  }

  /** Handle DeleteLoop RPC -- delete a loop (never a system infra job). */
  private async handleDeleteLoop(
    call: grpc.ServerUnaryCall<{ name: string }, unknown>,
    callback: grpc.sendUnaryData<{ success: boolean; message: string }>,
  ): Promise<void> {
    try {
      const { name } = call.request;
      const { CronStore } = await import("../cron/store.ts");
      const store = new CronStore();
      const job = await store.getJobByName(name);
      if (!job || job.userId !== "local") {
        callback(null, { success: false, message: "loop_not_found" });
        return;
      }
      if (job.source === "system") {
        callback(null, { success: false, message: "system_job_read_only" });
        return;
      }
      await store.deleteJob(job.id);
      process.emit("cron:refresh" as never);
      callback(null, { success: true, message: "deleted" });
    } catch (err) {
      callback(err as grpc.ServiceError, null);
    }
  }

  /** ListTasks RPC -- the local owner's scheduled tasks (cron_jobs), curated. */
  private async handleListTasks(
    _call: grpc.ServerUnaryCall<unknown, unknown>,
    callback: grpc.sendUnaryData<{ tasks: unknown[] }>,
  ): Promise<void> {
    try {
      const { CronStore } = await import("../cron/store.ts");
      const { curateConsumerTasks } = await import("../cron/task-view.ts");
      const jobs = await new CronStore().listJobs({ userId: "local" });
      callback(null, { tasks: curateConsumerTasks(jobs) });
    } catch (err) {
      callback(err as grpc.ServiceError, null);
    }
  }

  /** UpdateTask RPC -- full-state edit of a local task (toggle/rename/reschedule). */
  private async handleUpdateTask(
    call: grpc.ServerUnaryCall<
      {
        id?: string;
        name?: string;
        prompt?: string;
        schedule?: string;
        scheduleType?: string;
        enabled?: boolean;
      },
      unknown
    >,
    callback: grpc.sendUnaryData<{ success: boolean; message: string }>,
  ): Promise<void> {
    try {
      const req = call.request ?? {};
      if (!req.id) {
        callback(null, { success: false, message: "missing_id" });
        return;
      }
      const { CronStore } = await import("../cron/store.ts");
      const store = new CronStore();
      const job = await store.getJob(req.id);
      if (!job || job.userId !== "local") {
        callback(null, { success: false, message: "task_not_found" });
        return;
      }
      const updates: Record<string, unknown> = { enabled: Boolean(req.enabled) };
      if (req.name?.trim()) updates.name = req.name.trim();
      if (req.prompt?.trim()) updates.prompt = req.prompt;
      if (req.schedule?.trim()) {
        updates.schedule = req.schedule.trim();
        updates.scheduleType = req.scheduleType || job.scheduleType;
      }
      await store.updateJob(job.id, updates);
      process.emit("cron:refresh" as never);
      callback(null, { success: true, message: "updated" });
    } catch (err) {
      callback(err as grpc.ServiceError, null);
    }
  }

  /** DeleteTask RPC -- delete a local task. */
  private async handleDeleteTask(
    call: grpc.ServerUnaryCall<{ id?: string }, unknown>,
    callback: grpc.sendUnaryData<{ success: boolean; message: string }>,
  ): Promise<void> {
    try {
      const id = call.request?.id;
      if (!id) {
        callback(null, { success: false, message: "missing_id" });
        return;
      }
      const { CronStore } = await import("../cron/store.ts");
      const store = new CronStore();
      const job = await store.getJob(id);
      if (!job || job.userId !== "local") {
        callback(null, { success: false, message: "task_not_found" });
        return;
      }
      await store.deleteJob(job.id);
      process.emit("cron:refresh" as never);
      callback(null, { success: true, message: "deleted" });
    } catch (err) {
      callback(err as grpc.ServiceError, null);
    }
  }

  /** AnswerQuestion RPC -- resolve a pending ask_user elicitation out-of-band. */
  private handleAnswerQuestion(
    call: grpc.ServerUnaryCall<{ questionId?: string; answer?: string }, unknown>,
    callback: grpc.sendUnaryData<{ success: boolean; message: string }>,
  ): void {
    const { questionId, answer } = call.request ?? {};
    const ok =
      questionId && answer != null
        ? (this.elicitationManager?.resolveById(questionId, answer) ?? false)
        : false;
    callback(null, { success: Boolean(ok), message: ok ? "answered" : "no_pending_question" });
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

/**
 * Build server credentials. When `GRPC_TLS_CERT_PATH` + `GRPC_TLS_KEY_PATH`
 * are set, the server uses TLS. When `MTLS_CA_CERT_PATH` is also set, it
 * requires client certs signed by that CA (used for the OAuthDeposit RPC
 * called by nomos-server).
 *
 * Otherwise (dev / power-user) the server is plaintext on localhost.
 */
function buildServerCredentials(): grpc.ServerCredentials {
  const certPath = process.env.GRPC_TLS_CERT_PATH;
  const keyPath = process.env.GRPC_TLS_KEY_PATH;
  if (!certPath || !keyPath) {
    return grpc.ServerCredentials.createInsecure();
  }

  const cert = readFileSync(certPath);
  const key = readFileSync(keyPath);
  const caPath = process.env.MTLS_CA_CERT_PATH;
  const rootCerts = caPath ? readFileSync(caPath) : null;

  return grpc.ServerCredentials.createSsl(
    rootCerts,
    [{ private_key: key, cert_chain: cert }],
    // Require client cert (mTLS) iff a CA was provided.
    Boolean(caPath),
  );
}
