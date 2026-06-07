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

import { isHosted } from "../config/mode.ts";

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
 * Resolve the canonical owner id for durable per-user memory (the vault) from a
 * raw, per-message/per-request user id.
 *
 * Power-user (self-hosted) mode is a single owner's personal clone: every channel
 * (CLI, Slack, iMessage, Telegram, ...) is the same person, but the channel
 * adapters stamp `message.userId` with the platform sender id (e.g. a Slack user
 * id). Left as-is that would fragment the one vault into a separate brain per
 * channel and mismatch the settings UI, which reads `local`. So we COLLAPSE every
 * raw id to `LOCAL_TENANT.userId`. The column `DEFAULT 'local'` does not cover
 * this, because the daemon passes a non-null channel id that overrides it.
 *
 * Hosted (multi-tenant) mode genuinely has one vault per authenticated user, so
 * we keep the resolved per-request id (falling back to local only if absent,
 * which upstream auth should prevent).
 *
 * Use this wherever a vault/durable-memory `user_id` is derived from an incoming
 * message or request. Behavioral/ephemeral signals keyed by sender (persona,
 * theory-of-mind) keep the raw id; this is only for durable per-user memory.
 */
export function resolveVaultUserId(rawUserId?: string | null): string {
  if (!isHosted()) return LOCAL_TENANT.userId;
  return rawUserId ?? LOCAL_TENANT.userId;
}

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
