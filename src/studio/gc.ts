/**
 * Studio garbage collection. The single clock for object/row cleanup (chosen
 * over GCS object-lifecycle rules so the DB and the bucket can never disagree and
 * the history strip never shows a thumbnail whose object was reaped). Fired by the
 * __studio_gc__ cron sentinel, per owner.
 *
 * Two sweeps:
 *   1. Unconfirmed uploads (assets stuck `pending` past a TTL) -> expire + drop.
 *   2. Aged intermediate edit results that are no longer the chain head -> expire
 *      + drop output/preview blobs. Originals (the asset object) and the live head
 *      output are always kept. Rows are marked `expired` BEFORE the object is
 *      deleted. See nomos-docs/studio-plan.md section 3 (object lifecycle).
 */

import { sql } from "kysely";
import type { TenantContext } from "../auth/tenant-context.ts";
import { getKysely } from "../db/client.ts";
import { createLogger } from "../lib/logger.ts";
import { getObjectStore, type ObjectStore } from "../storage/object-store.ts";

const log = createLogger("studio-gc");

export const STUDIO_GC_SENTINEL = "__studio_gc__";
const PENDING_TTL_HOURS = 24;
const INTERMEDIATE_TTL_DAYS = 30;

export interface StudioGcResult {
  assetsExpired: number;
  editsExpired: number;
  objectsDeleted: number;
}

export interface StudioGcOptions {
  store?: ObjectStore;
  now?: number;
  pendingTtlHours?: number;
  intermediateTtlDays?: number;
}

async function dropObject(store: ObjectStore, key: string | null): Promise<boolean> {
  if (!key) return false;
  try {
    await store.delete(key);
    return true;
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : err, key }, "gc: object delete failed");
    return false;
  }
}

/** Run both GC sweeps for one owner. Scoped by user_id. */
export async function runStudioGcForUser(
  ctx: TenantContext,
  opts: StudioGcOptions = {},
): Promise<StudioGcResult> {
  const db = getKysely();
  const store = opts.store ?? getObjectStore();
  const now = opts.now ?? Date.now();
  const pendingCutoff = new Date(now - (opts.pendingTtlHours ?? PENDING_TTL_HOURS) * 3_600_000);
  const intermediateCutoff = new Date(
    now - (opts.intermediateTtlDays ?? INTERMEDIATE_TTL_DAYS) * 86_400_000,
  );

  let objectsDeleted = 0;

  // 1) Unconfirmed uploads.
  const pending = await db
    .selectFrom("studio_assets")
    .select(["id", "object_key"])
    .where("user_id", "=", ctx.userId)
    .where("status", "=", "pending")
    .where("created_at", "<", pendingCutoff)
    .execute();
  for (const a of pending) {
    if (await dropObject(store, a.object_key)) objectsDeleted++;
  }
  if (pending.length > 0) {
    await db
      .updateTable("studio_assets")
      .set({ status: "expired", updated_at: sql`now()` })
      .where("user_id", "=", ctx.userId)
      .where(
        "id",
        "in",
        pending.map((a) => a.id),
      )
      .execute();
  }

  // 2) Aged intermediate edit results (anything that is no longer the chain head).
  const intermediates = await db
    .selectFrom("studio_edits as e")
    .innerJoin("studio_assets as a", "a.id", "e.asset_id")
    .select(["e.id as id", "e.output_key as output_key", "e.preview_key as preview_key"])
    .where("e.user_id", "=", ctx.userId)
    .where("e.status", "=", "done")
    .where("e.created_at", "<", intermediateCutoff)
    .where(sql<boolean>`a.head_edit_id is distinct from e.id`)
    .execute();
  for (const e of intermediates) {
    if (await dropObject(store, e.output_key)) objectsDeleted++;
    if (await dropObject(store, e.preview_key)) objectsDeleted++;
  }
  if (intermediates.length > 0) {
    await db
      .updateTable("studio_edits")
      .set({ status: "expired", output_key: null, preview_key: null, updated_at: sql`now()` })
      .where("user_id", "=", ctx.userId)
      .where(
        "id",
        "in",
        intermediates.map((e) => e.id),
      )
      .execute();
  }

  return { assetsExpired: pending.length, editsExpired: intermediates.length, objectsDeleted };
}

/** Fan out the GC over every memory owner. Called by the __studio_gc__ sentinel. */
export async function runStudioGc(opts: StudioGcOptions = {}): Promise<StudioGcResult> {
  const { listMemoryOwners } = await import("../auth/org-members.ts");
  const totals: StudioGcResult = { assetsExpired: 0, editsExpired: 0, objectsDeleted: 0 };
  for (const userId of await listMemoryOwners()) {
    try {
      const ctx: TenantContext = { orgId: process.env.NOMOS_ORG_ID ?? "local", userId };
      const r = await runStudioGcForUser(ctx, opts);
      totals.assetsExpired += r.assetsExpired;
      totals.editsExpired += r.editsExpired;
      totals.objectsDeleted += r.objectsDeleted;
    } catch (err) {
      log.error(
        { err: err instanceof Error ? err.message : err, userId },
        "studio gc failed for owner",
      );
    }
  }
  return totals;
}
