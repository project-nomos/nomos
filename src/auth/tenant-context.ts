/**
 * TenantContext flows through every per-user DB call and gRPC handler in
 * hosted mode. It carries the authenticated `orgId` (which must match the
 * instance's NOMOS_ORG_ID env at runtime) and `userId` (BA user.id).
 *
 * Per-user query helpers must accept a TenantContext parameter and append
 * `WHERE user_id = ${ctx.userId}` to every SELECT/UPDATE/DELETE, and set
 * `user_id = ctx.userId` on every INSERT. The type system makes the
 * dependency explicit so a forgotten ctx is a compile error, not a data
 * leak.
 *
 * Power-user mode (single-tenant local install) uses the singleton
 * `LOCAL_TENANT` so existing functions keep working without rewrites.
 */

export interface TenantContext {
  /** BA organization id. Matches process.env.NOMOS_ORG_ID. */
  readonly orgId: string;
  /** BA user.id. Pulled from the JWT `sub` claim by the gRPC interceptor. */
  readonly userId: string;
}

/**
 * Singleton context for non-hosted (single-user, single-tenant) installs.
 * The local user always exists; the local org is the install itself.
 */
export const LOCAL_TENANT: TenantContext = {
  orgId: "local",
  userId: "local",
};

/**
 * Resolve the active context for code that doesn't have a request-scoped one
 * (e.g., the daemon's startup bootstrapping, cron-engine jobs). In hosted
 * mode this returns the synthetic system tenant ({orgId: NOMOS_ORG_ID,
 * userId: "system"}); in power-user mode it returns LOCAL_TENANT.
 *
 * Per-request code MUST use the ctx attached by the gRPC interceptor instead
 * of calling this — system tenant bypasses user_id filtering and should only
 * be used for instance-wide work like cron, ingestion, and memory indexing.
 */
export function systemTenant(): TenantContext {
  const orgId = process.env.NOMOS_ORG_ID;
  if (orgId) {
    return { orgId, userId: "system" };
  }
  return LOCAL_TENANT;
}
