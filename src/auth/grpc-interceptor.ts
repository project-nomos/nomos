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
// Single source of truth for "are we hosted": getMode() already folds in
// AUTH_JWKS_URL, so auth enforcement here and per-user vault scoping in
// resolveVaultUserId can never disagree (a skew would collapse authenticated
// users onto the shared 'local' vault).
import { isHosted } from "../config/mode.ts";

const log = createLogger("grpc-interceptor");

/** Method symbol used to stash the resolved context on the call object. */
export const CTX_SYMBOL = Symbol.for("nomos.tenantContext");

/** Methods that bypass JWT validation (mTLS-only). */
const MTLS_ONLY_METHODS = new Set(["/nomos.OAuthDeposit/Deposit"]);

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
 * Resolve a TenantContext for a gRPC call. Use inside a handler:
 *
 *   const ctx = await resolveContext(call, "/nomos.MobileApi/GetMessages");
 *   if (!ctx) { callback({ code: status.UNAUTHENTICATED }); return; }
 *
 * Throws no exceptions — returns `null` on missing/invalid token (the caller
 * is responsible for surfacing an UNAUTHENTICATED error). On mTLS-only or
 * power-user paths, returns LOCAL_TENANT.
 */
export async function resolveContext(
  call: { metadata: grpc.Metadata },
  methodPath: string,
): Promise<{ ctx: TenantContext } | { error: grpc.ServiceError }> {
  if (MTLS_ONLY_METHODS.has(methodPath) || !isHosted()) {
    return { ctx: LOCAL_TENANT };
  }
  const token = bearerToken(call.metadata);
  if (!token) {
    return {
      error: Object.assign(new Error("missing_token"), {
        code: grpc.status.UNAUTHENTICATED,
        details: "missing_token",
        metadata: new grpc.Metadata(),
      }) as grpc.ServiceError,
    };
  }
  let ctx: TenantContext;
  try {
    ctx = await verifyJwt(token);
  } catch (err) {
    const reason = err instanceof JwtValidationError ? err.message : "verification_failed";
    log.warn({ methodPath, reason }, "Rejecting unauthenticated call");
    return {
      error: Object.assign(new Error(reason), {
        code: grpc.status.UNAUTHENTICATED,
        details: reason,
        metadata: new grpc.Metadata(),
      }) as grpc.ServiceError,
    };
  }
  const member = await isOrgMember(ctx.userId);
  if (!member) {
    return {
      error: Object.assign(new Error("not_org_member"), {
        code: grpc.status.PERMISSION_DENIED,
        details: "not_org_member",
        metadata: new grpc.Metadata(),
      }) as grpc.ServiceError,
    };
  }
  return { ctx };
}

/**
 * Wrap a unary handler with auth resolution. Returns a function in the
 * grpc-js `handleUnaryCall` shape: (call, callback). Skipped for mTLS-only
 * methods, no-op in power-user mode.
 */
export function withAuthUnary<TReq, TRes>(
  methodPath: string,
  handler: (call: grpc.ServerUnaryCall<TReq, TRes>, ctx: TenantContext) => Promise<TRes>,
): grpc.handleUnaryCall<TReq, TRes> {
  return (call, callback) => {
    resolveContext(call, methodPath).then(async (r) => {
      if ("error" in r) {
        callback(r.error);
        return;
      }
      Reflect.set(call, CTX_SYMBOL, r.ctx);
      try {
        const result = await handler(call, r.ctx);
        callback(null, result);
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        callback({ code: grpc.status.INTERNAL, message: e.message });
      }
    });
  };
}

/**
 * Wrap a server-streaming handler with auth resolution.
 */
export function withAuthStream<TReq, TRes>(
  methodPath: string,
  handler: (
    call: grpc.ServerWritableStream<TReq, TRes>,
    ctx: TenantContext,
  ) => void | Promise<void>,
): grpc.handleServerStreamingCall<TReq, TRes> {
  return (call) => {
    resolveContext(call, methodPath).then(async (r) => {
      if ("error" in r) {
        call.destroy(r.error);
        return;
      }
      Reflect.set(call, CTX_SYMBOL, r.ctx);
      try {
        await handler(call, r.ctx);
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        call.destroy(e);
      }
    });
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
