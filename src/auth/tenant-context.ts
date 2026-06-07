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
 * Synthetic / non-human owner ids that must NEVER become a durable per-user
 * memory partition (a vault, a user model, a graph). They belong to internal
 * machinery, not a person: the cron scheduler, the `system` instance tenant, and
 * remote agent DIDs from CATE (`did:...`). In hosted mode these collapse onto the
 * instance owner instead of minting a junk per-id partition.
 */
const SYNTHETIC_OWNER_IDS = new Set(["system", "cron-scheduler"]);

function isSyntheticOwnerId(id: string): boolean {
  return SYNTHETIC_OWNER_IDS.has(id) || id.startsWith("did:");
}

/**
 * Resolve the canonical owner id for ALL durable per-user memory (the vault,
 * memory_chunks, user_model, contacts, the knowledge graph) from a raw,
 * per-message/per-request user id.
 *
 * Power-user (self-hosted) mode is a single owner's personal clone: every channel
 * (CLI, Slack, iMessage, Telegram, ...) is the same person, but the channel
 * adapters stamp `message.userId` with the platform sender id (e.g. a Slack user
 * id). Left as-is that would fragment the one brain into a separate partition per
 * channel and mismatch the settings UI, which reads `local`. So we COLLAPSE every
 * raw id to `LOCAL_TENANT.userId`. The column `DEFAULT 'local'` does not cover
 * this, because the daemon passes a non-null channel id that overrides it.
 *
 * Hosted (multi-tenant) mode genuinely has one partition per authenticated user,
 * so we keep the resolved per-request id, EXCEPT when it is absent or synthetic
 * (cron scheduler, CATE DID, the `system` sentinel): those collapse onto the
 * instance owner (`systemTenant().userId`) so internal machinery never creates a
 * junk per-id partition. Real owners for cron/CATE traffic are supplied upstream
 * (the job's owner, the local recipient), so this is the safety net.
 *
 * Behavioral/ephemeral signals keyed by sender (persona, theory-of-mind) keep the
 * raw id; this is only for durable per-user memory.
 */
export function resolveMemoryUserId(rawUserId?: string | null): string {
  if (!isHosted()) return LOCAL_TENANT.userId;
  if (!rawUserId || isSyntheticOwnerId(rawUserId)) return systemTenant().userId;
  return rawUserId;
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
