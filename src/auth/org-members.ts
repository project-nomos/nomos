/**
 * Small in-memory cache of `org_members` rows that are eventually-consistent
 * with Better Auth's organization plugin. Used by the gRPC interceptor to
 * confirm a JWT's `sub` is a current member of NOMOS_ORG_ID before letting
 * the request through.
 *
 * The org_members table is per-customer-schema (one row per BA member of
 * the instance's org). Better Auth pushes updates here via a webhook
 * subscribed in Phase 5+; for now we maintain it lazily on first contact.
 *
 * Power-user mode (no JWT validation) bypasses this entirely.
 */

import { sql } from "kysely";
import { getKysely } from "../db/client.ts";
import { createLogger } from "../lib/logger.ts";
import { isHosted } from "../config/mode.ts";
import { LOCAL_TENANT, systemTenant } from "./tenant-context.ts";

const log = createLogger("org-members");

/**
 * The owners that per-user background jobs (wiki compile, consolidation,
 * commitment reminders) must run for. Power-user is a single owner ('local'); a
 * hosted multi-member DB enumerates its members so each gets their own pass.
 * Falls back to the instance owner if membership is not yet populated.
 */
export async function listMemoryOwners(): Promise<string[]> {
  if (!isHosted()) return [LOCAL_TENANT.userId];
  try {
    const db = getKysely();
    // Enumerate owners that actually have memory to process, from the reliably
    // per-user-stamped memory tables (memory_chunks + user_model). This is the
    // exact set background jobs should run for, and is population-free (no
    // dependence on the org_members webhook). Falls back to the instance owner.
    const result = await db.executeQuery<{ user_id: string }>(
      sql`
        SELECT DISTINCT user_id FROM memory_chunks
        UNION
        SELECT DISTINCT user_id FROM user_model
      `.compile(db),
    );
    const ids = result.rows.map((r) => r.user_id).filter(Boolean);
    return ids.length > 0 ? ids : [systemTenant().userId];
  } catch {
    return [systemTenant().userId];
  }
}

const TTL_MS = 60_000;

interface CacheEntry {
  fetchedAt: number;
  isMember: boolean;
}

const cache = new Map<string, CacheEntry>();

/**
 * Returns true iff the given user is a current member of NOMOS_ORG_ID.
 *
 * Soft-fail (returns true) when the org_members table doesn't exist yet
 * (pre-Phase-5 schemas) so the rest of the auth chain still works.
 */
export async function isOrgMember(userId: string): Promise<boolean> {
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.fetchedAt < TTL_MS) {
    return hit.isMember;
  }

  try {
    const db = getKysely();
    // org_members is created idempotently on first use via the SQL below.
    await db
      .executeQuery(
        sql`
          CREATE TABLE IF NOT EXISTS org_members (
            user_id    TEXT PRIMARY KEY,
            role       TEXT NOT NULL DEFAULT 'member',
            added_at   TIMESTAMPTZ NOT NULL DEFAULT now()
          )
        `.compile(db),
      )
      .catch(() => undefined);

    const result = await db.executeQuery(
      sql<{
        present: number;
      }>`SELECT 1 AS present FROM org_members WHERE user_id = ${userId} LIMIT 1`.compile(db),
    );

    const isMember = result.rows.length > 0;
    cache.set(userId, { fetchedAt: Date.now(), isMember });
    return isMember;
  } catch (err) {
    log.warn({ err, userId }, "Failed to check org membership; failing open");
    return true;
  }
}

/**
 * Webhook target / admin-side helper: add a member to this instance's org.
 */
export async function addOrgMember(
  userId: string,
  role: "owner" | "admin" | "member" = "member",
): Promise<void> {
  const db = getKysely();
  await db
    .executeQuery(
      sql`
        CREATE TABLE IF NOT EXISTS org_members (
          user_id    TEXT PRIMARY KEY,
          role       TEXT NOT NULL DEFAULT 'member',
          added_at   TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `.compile(db),
    )
    .catch(() => undefined);

  await db.executeQuery(
    sql`
        INSERT INTO org_members (user_id, role) VALUES (${userId}, ${role})
        ON CONFLICT (user_id) DO UPDATE SET role = excluded.role
      `.compile(db),
  );
  cache.set(userId, { fetchedAt: Date.now(), isMember: true });
}

/**
 * Drop the cache (called on logout / forced refresh).
 */
export function invalidate(userId?: string): void {
  if (userId) cache.delete(userId);
  else cache.clear();
}
