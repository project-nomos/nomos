/**
 * Connect-protocol adapter for the MobileApi service.
 *
 * Mounts the same handlers as src/daemon/grpc-server.ts but speaks the Connect
 * protocol over HTTP/1.1, which React Native and browsers can consume directly
 * without a gRPC-Web proxy or HTTP/2 frame multiplexing.
 *
 * Runs alongside the @grpc/grpc-js server on a separate port (default 8767).
 * Mobile clients hit this; the Mac/CLI client continues to hit the raw gRPC
 * server on 8766. Auth is the same Bearer JWT — we reuse `resolveContext`
 * by faking a grpc.Metadata wrapper around HTTP headers.
 */

import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import * as grpc from "@grpc/grpc-js";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import type { ConnectRouter, HandlerContext } from "@connectrpc/connect";
import { ConnectError, Code } from "@connectrpc/connect";
import { MobileApi } from "../gen/nomos_pb.ts";
import { resolveContext } from "../auth/grpc-interceptor.ts";
import { handleBlobRequest } from "../storage/object-store.ts";
import { buildMobileApiHandlers } from "./mobile-api.ts";
import type { MessageQueue } from "./message-queue.ts";
import type { DraftManager } from "./draft-manager.ts";
import type { AgentEvent, IncomingMessage as ChannelMessage } from "./types.ts";
import { createLogger } from "../lib/logger.ts";

const log = createLogger("connect-server");

export interface ConnectServerDeps {
  messageQueue: MessageQueue;
  draftManager: DraftManager | null;
  port: number;
}

export class ConnectServer {
  private deps: ConnectServerDeps;
  private server: ReturnType<typeof createServer> | null = null;

  constructor(deps: ConnectServerDeps) {
    this.deps = deps;
  }

  start(): Promise<void> {
    const messageQueue = this.deps.messageQueue;
    const handlers = buildMobileApiHandlers({
      messageQueue,
      draftManager: this.deps.draftManager,
    });

    const routes = (router: ConnectRouter) => {
      // Cast: the gRPC handlers return plain JS objects matching the proto
      // field names in camelCase, which are structurally MessageInit values.
      // The Connect-ES types can't infer this through our generic unary()
      // adapter, but at runtime the shapes match exactly.
      router.service(MobileApi, {
        // ── Chat (server-streaming) ──
        chat: async function* (req: { content: string; sessionKey: string }, ctx: HandlerContext) {
          const tenantCtx = await contextFromHeaders(ctx, "/nomos.MobileApi/Chat");

          const queue: AgentEvent[] = [];
          let resolveNext: ((v: AgentEvent | null) => void) | null = null;
          let done = false;

          const emit = (event: AgentEvent) => {
            if (resolveNext) {
              const r = resolveNext;
              resolveNext = null;
              r(event);
            } else {
              queue.push(event);
            }
          };

          const incoming: ChannelMessage = {
            id: randomUUID(),
            platform: "mobile",
            channelId: req.sessionKey || `mobile:${tenantCtx.userId}`,
            userId: tenantCtx.userId,
            content: req.content ?? "",
            timestamp: new Date(),
          };

          messageQueue
            .enqueue(incoming.channelId, incoming, emit)
            .then(() => {
              done = true;
              if (resolveNext) {
                resolveNext(null);
                resolveNext = null;
              }
            })
            .catch((err: unknown) => {
              emit({
                type: "error",
                message: err instanceof Error ? err.message : String(err),
              });
              done = true;
              if (resolveNext) {
                resolveNext(null);
                resolveNext = null;
              }
            });

          while (true) {
            if (queue.length > 0) {
              const e = queue.shift() as AgentEvent;
              const { type, ...rest } = e;
              yield { type, jsonPayload: JSON.stringify(rest) };
              continue;
            }
            if (done) break;
            const next = await new Promise<AgentEvent | null>((r) => {
              resolveNext = r;
            });
            if (next === null) break;
            const { type, ...rest } = next;
            yield { type, jsonPayload: JSON.stringify(rest) };
          }
        },

        // ── Unary RPCs — delegate to the same handler bodies as gRPC. ──
        getMessages: unary(handlers.GetMessages),
        approveDraft: unary(handlers.ApproveDraft),
        rejectDraft: unary(handlers.RejectDraft),
        approveDraftWithEdit: unary(handlers.ApproveDraftWithEdit),
        listInbox: unary(handlers.ListInbox),
        getCateEnvelope: unary(handlers.GetCateEnvelope),
        actOnInboxItem: unary(handlers.ActOnInboxItem),
        listSkills: unary(handlers.ListSkills),
        toggleSkill: unary(handlers.ToggleSkill),
        getEarnings: unary(handlers.GetEarnings),
        getGraph: unary(handlers.GetGraph),
        getGraphNeighbors: unary(handlers.GetGraphNeighbors),
        searchGraph: unary(handlers.SearchGraph),
        getSettings: unary(handlers.GetSettings),
        updateConsent: unary(handlers.UpdateConsent),
        updateTrustTier: unary(handlers.UpdateTrustTier),
        updatePermission: unary(handlers.UpdatePermission),
        listIntegrations: unary(handlers.ListIntegrations),
        startConnectIntegration: unary(handlers.StartConnectIntegration),
        connectGoogleAccount: unary(handlers.ConnectGoogleAccount),
        setGoogleSend: unary(handlers.SetGoogleSend),
        disconnectIntegration: unary(handlers.DisconnectIntegration),
        registerDevice: unary(handlers.RegisterDevice),
        unregisterDevice: unary(handlers.UnregisterDevice),
        listVaultNotes: unary(handlers.ListVaultNotes),
        getVaultNote: unary(handlers.GetVaultNote),
        writeVaultNote: unary(handlers.WriteVaultNote),
        deleteVaultNote: unary(handlers.DeleteVaultNote),

        // ── Loops ──
        listLoops: unary(handlers.ListLoops),
        setLoopEnabled: unary(handlers.SetLoopEnabled),
        deleteLoop: unary(handlers.DeleteLoop),

        // ── Studio (hosted-only). Without these the iOS app's Studio calls hit a
        //    404 over Connect even though the gRPC server (Mac/CLI) has them. ──
        studioCreateAsset: unary(handlers.StudioCreateAsset),
        studioGetAssetUrl: unary(handlers.StudioGetAssetUrl),
        studioEdit: serverStream(handlers.StudioEdit), // server-streaming, like chat
        studioHistory: unary(handlers.StudioHistory),
        studioReportIdentity: unary(handlers.StudioReportIdentity),
      } as unknown as Parameters<typeof router.service<typeof MobileApi>>[1]);
    };

    return new Promise((resolveStart, reject) => {
      // Signed blob PUT/GET for the local-fs object store are served here too (same
      // host:port the client already reached us on); everything else is Connect RPC.
      const connectHandler = connectNodeAdapter({ routes });
      this.server = createServer((req, res) => {
        void handleBlobRequest(req, res).then((handled) => {
          if (!handled) connectHandler(req, res);
        });
      });
      this.server.listen(this.deps.port, "0.0.0.0", () => {
        log.info(`Connect server listening on 0.0.0.0:${this.deps.port}`);
        resolveStart();
      });
      this.server.on("error", (err: Error) => {
        log.error({ err }, "Connect server error");
        reject(err);
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => {
        this.server = null;
        resolve();
      });
    });
  }
}

// ── Helpers ──

/**
 * Build a fake grpc.Metadata from the Connect request headers so we can reuse
 * the existing `resolveContext` JWT path. We only need the `authorization`
 * header — that's what bearerToken() reads.
 */
async function contextFromHeaders(ctx: HandlerContext, methodPath: string) {
  const metadata = new grpc.Metadata();
  const auth = ctx.requestHeader.get("authorization");
  if (auth) metadata.set("authorization", auth);

  const r = await resolveContext({ metadata }, methodPath);
  if ("error" in r) {
    throw new ConnectError(
      grpcErrorMessage(r.error),
      r.error.code === grpc.status.UNAUTHENTICATED ? Code.Unauthenticated : Code.PermissionDenied,
    );
  }
  return r.ctx;
}

/**
 * Adapt a gRPC unary handler — `(call, callback)` shape — to a Connect
 * unary handler — `(req, ctx) => res`. The gRPC handler already runs auth via
 * `withAuthUnary`; we synthesize a `call` that exposes `request` and
 * `metadata`, then translate the callback into a promise.
 */
function unary<TReq, TRes>(grpcHandler: grpc.handleUnaryCall<TReq, TRes>) {
  return (req: TReq, ctx: HandlerContext): Promise<TRes> => {
    return new Promise<TRes>((resolve, reject) => {
      const metadata = new grpc.Metadata();
      const auth = ctx.requestHeader.get("authorization");
      if (auth) metadata.set("authorization", auth);

      const fakeCall = {
        request: req,
        metadata,
        cancelled: false,
      } as unknown as grpc.ServerUnaryCall<TReq, TRes>;

      grpcHandler(fakeCall, ((err: grpc.ServiceError | null, value: TRes | undefined) => {
        if (err) {
          reject(new ConnectError(grpcErrorMessage(err), translateCode(err.code)));
        } else {
          resolve(value as TRes);
        }
      }) as grpc.sendUnaryData<TRes>);
    });
  };
}

/**
 * Adapt a gRPC SERVER-STREAMING handler — `(call) => void`, emitting via
 * `call.write()` and finishing on `call.end()` / `call.destroy()` — to a Connect
 * async-generator handler. We synthesize a writable `call` that funnels writes into
 * a queue the generator drains, mirroring `unary()` for auth (the gRPC handler reads
 * the JWT off `call.metadata`).
 */
function serverStream<TReq, TRes>(grpcHandler: grpc.handleServerStreamingCall<TReq, TRes>) {
  return async function* (req: TReq, ctx: HandlerContext): AsyncGenerator<TRes> {
    const metadata = new grpc.Metadata();
    const auth = ctx.requestHeader.get("authorization");
    if (auth) metadata.set("authorization", auth);

    const queue: TRes[] = [];
    let resolveNext: ((v: TRes | null) => void) | null = null;
    let ended = false;
    const box: { failure: Error | null } = { failure: null };

    const wake = (v: TRes | null) => {
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r(v);
      }
    };
    const finish = (err?: Error) => {
      if (err && !box.failure) box.failure = err;
      ended = true;
      wake(null);
    };

    const fakeCall = {
      request: req,
      metadata,
      cancelled: false,
      write: (msg: TRes) => {
        if (resolveNext) wake(msg);
        else queue.push(msg);
        return true;
      },
      end: () => finish(),
      destroy: (err?: Error) => finish(err),
      on: () => fakeCall,
      once: () => fakeCall,
      off: () => fakeCall,
      removeListener: () => fakeCall,
      emit: () => false,
    } as unknown as grpc.ServerWritableStream<TReq, TRes>;

    // Kick off the handler; it writes events + ends/destroys the fake call.
    grpcHandler(fakeCall);

    while (true) {
      if (queue.length > 0) {
        yield queue.shift() as TRes;
        continue;
      }
      if (ended) break;
      const next = await new Promise<TRes | null>((r) => {
        resolveNext = r;
      });
      if (next === null) break;
      yield next;
    }
    if (box.failure) {
      throw new ConnectError(box.failure.message || "internal", Code.Internal);
    }
  };
}

function grpcErrorMessage(err: grpc.ServiceError | Partial<grpc.StatusObject>): string {
  if ("details" in err && typeof err.details === "string" && err.details.length > 0) {
    return err.details;
  }
  if ("message" in err && typeof err.message === "string") return err.message;
  return "internal";
}

function translateCode(code: grpc.status | undefined): Code {
  switch (code) {
    case grpc.status.UNAUTHENTICATED:
      return Code.Unauthenticated;
    case grpc.status.PERMISSION_DENIED:
      return Code.PermissionDenied;
    case grpc.status.NOT_FOUND:
      return Code.NotFound;
    case grpc.status.INVALID_ARGUMENT:
      return Code.InvalidArgument;
    case grpc.status.UNIMPLEMENTED:
      return Code.Unimplemented;
    default:
      return Code.Internal;
  }
}
