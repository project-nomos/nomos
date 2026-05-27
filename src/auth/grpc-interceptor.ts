/**
 * gRPC server interceptor that resolves a TenantContext from the
 * `authorization: Bearer <jwt>` metadata. Attached to every Mobile API and
 * customer-facing RPC.
 *
 * Skipped entirely in power-user mode (no NOMOS_ORG_ID, no AUTH_JWKS_URL):
 * the daemon trusts the local connection and uses LOCAL_TENANT.
 *
 * The OAuthDeposit service is excluded — it's authenticated via mTLS at the
 * TLS layer, not via JWT.
 */

import * as grpc from "@grpc/grpc-js";
import { createLogger } from "../lib/logger.ts";
import { verifyJwt, JwtValidationError } from "./jwt-validator.ts";
import { isOrgMember } from "./org-members.ts";
import { LOCAL_TENANT, type TenantContext } from "./tenant-context.ts";

const log = createLogger("grpc-interceptor");

/** Method symbol used to stash the resolved context on the call object. */
export const CTX_SYMBOL = Symbol.for("nomos.tenantContext");

/** Methods that bypass JWT validation (mTLS-only). */
const MTLS_ONLY_METHODS = new Set(["/nomos.OAuthDeposit/Deposit"]);

function isHosted(): boolean {
  return process.env.NOMOS_MODE === "hosted" || Boolean(process.env.AUTH_JWKS_URL);
}

function bearerToken(metadata: grpc.Metadata): string | null {
  const raw = metadata.get("authorization");
  if (!raw || raw.length === 0) return null;
  const value = String(raw[0]);
  const m = value.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

export interface ResolvedContext {
  ctx: TenantContext;
}

/**
 * Wrap a gRPC handler with auth resolution. Use this to compose interceptors
 * onto each method when adding service handlers.
 */
export function withAuth<TReq, TRes>(
  methodPath: string,
  handler: (
    call: grpc.ServerUnaryCall<TReq, TRes> | grpc.ServerWritableStream<TReq, TRes>,
    ctx: TenantContext,
  ) => Promise<void> | void,
): (
  call: grpc.ServerUnaryCall<TReq, TRes> | grpc.ServerWritableStream<TReq, TRes>,
  callback?: grpc.sendUnaryData<TRes>,
) => Promise<void> {
  return async (call, callback) => {
    if (MTLS_ONLY_METHODS.has(methodPath) || !isHosted()) {
      // Power-user / mTLS path: skip JWT, attach LOCAL_TENANT.
      Reflect.set(call, CTX_SYMBOL, LOCAL_TENANT);
      try {
        await handler(call, LOCAL_TENANT);
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        if (callback) callback({ code: grpc.status.INTERNAL, message: e.message });
        else (call as grpc.ServerWritableStream<TReq, TRes>).destroy(e);
      }
      return;
    }

    // Hosted: require Bearer + verify
    const token = bearerToken(call.metadata);
    if (!token) {
      const err: grpc.ServiceError = Object.assign(new Error("missing_token"), {
        code: grpc.status.UNAUTHENTICATED,
        details: "missing_token",
        metadata: new grpc.Metadata(),
      });
      if (callback) callback(err);
      else (call as grpc.ServerWritableStream<TReq, TRes>).emit("error", err);
      return;
    }

    let ctx: TenantContext;
    try {
      ctx = await verifyJwt(token);
    } catch (err) {
      const reason = err instanceof JwtValidationError ? err.message : "verification_failed";
      log.warn({ err, methodPath, reason }, "Rejecting unauthenticated call");
      const e: grpc.ServiceError = Object.assign(new Error(reason), {
        code: grpc.status.UNAUTHENTICATED,
        details: reason,
        metadata: new grpc.Metadata(),
      });
      if (callback) callback(e);
      else (call as grpc.ServerWritableStream<TReq, TRes>).emit("error", e);
      return;
    }

    // Defense in depth: confirm user_id is a current member of this org
    const member = await isOrgMember(ctx.userId);
    if (!member) {
      const e: grpc.ServiceError = Object.assign(new Error("not_org_member"), {
        code: grpc.status.PERMISSION_DENIED,
        details: "not_org_member",
        metadata: new grpc.Metadata(),
      });
      if (callback) callback(e);
      else (call as grpc.ServerWritableStream<TReq, TRes>).emit("error", e);
      return;
    }

    Reflect.set(call, CTX_SYMBOL, ctx);
    try {
      await handler(call, ctx);
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      if (callback) callback({ code: grpc.status.INTERNAL, message: e.message });
      else (call as grpc.ServerWritableStream<TReq, TRes>).destroy(e);
    }
  };
}

/**
 * Pull the resolved TenantContext off a gRPC call. Throws if no interceptor
 * ran — that's a wiring bug.
 */
export function getContext(call: object): TenantContext {
  const ctx = Reflect.get(call, CTX_SYMBOL) as TenantContext | undefined;
  if (!ctx) throw new Error("TenantContext missing — interceptor not wired");
  return ctx;
}
