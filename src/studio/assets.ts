/**
 * Studio asset + edit-chain bookkeeping over `studio_assets` / `studio_edits`.
 *
 * Every function takes a `TenantContext` and filters by `user_id` at the query
 * layer (zero-trust on top of database-per-customer). Originals are immutable;
 * edits append to a linear chain. `appendEdit` enforces, in one transaction:
 *   - idempotency: a retried edit with a committed idempotency_key returns the
 *     existing row (stream-drop retries are free),
 *   - optimistic concurrency: the edit must build on the asset's current head,
 *     else StaleParentError (the client refreshes and retries).
 *
 * See the design doc sections 3 + 8 (decision 4).
 */

import { type Selectable, sql } from "kysely";
import type { TenantContext } from "../auth/tenant-context.ts";
import { getKysely } from "../db/client.ts";
import type { StudioAssetsTable, StudioEditsTable } from "../db/types.ts";
import { OP_SPEC_VERSION, type StudioOp } from "./ops.ts";

export type StudioAssetStatus = "pending" | "ready" | "expired";
export type StudioEditStatus = "pending" | "running" | "done" | "failed" | "expired";

export interface StudioAsset {
  id: string;
  userId: string;
  objectKey: string;
  contentHash: string;
  mime: string;
  width: number | null;
  height: number | null;
  bytes: number;
  status: StudioAssetStatus;
  headEditId: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface StudioEdit {
  id: string;
  assetId: string;
  userId: string;
  parentEditId: string | null;
  idempotencyKey: string;
  op: string;
  opSpecVersion: number;
  params: Record<string, unknown>;
  provider: string | null;
  inputKey: string | null;
  outputKey: string | null;
  previewKey: string | null;
  status: StudioEditStatus;
  costUsd: number;
  identityScore: number | null;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export class StudioAssetNotFoundError extends Error {
  constructor(public readonly assetId: string) {
    super(`Studio asset not found: ${assetId}`);
    this.name = "StudioAssetNotFoundError";
  }
}

/** The edit's parent_edit_id no longer matches the asset head (a concurrent edit won). */
export class StaleParentError extends Error {
  constructor(
    public readonly provided: string | null,
    public readonly head: string | null,
  ) {
    super(`Stale parent edit: provided ${provided ?? "null"}, head is ${head ?? "null"}`);
    this.name = "StaleParentError";
  }
}

function mapAsset(r: Selectable<StudioAssetsTable>): StudioAsset {
  return {
    id: r.id,
    userId: r.user_id,
    objectKey: r.object_key,
    contentHash: r.content_hash,
    mime: r.mime,
    width: r.width,
    height: r.height,
    bytes: r.bytes,
    status: r.status as StudioAssetStatus,
    headEditId: r.head_edit_id,
    metadata: r.metadata ?? {},
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function mapEdit(r: Selectable<StudioEditsTable>): StudioEdit {
  return {
    id: r.id,
    assetId: r.asset_id,
    userId: r.user_id,
    parentEditId: r.parent_edit_id,
    idempotencyKey: r.idempotency_key,
    op: r.op,
    opSpecVersion: r.op_spec_version,
    params: r.params ?? {},
    provider: r.provider,
    inputKey: r.input_key,
    outputKey: r.output_key,
    previewKey: r.preview_key,
    status: r.status as StudioEditStatus,
    costUsd: r.cost_usd,
    identityScore: r.identity_score,
    error: r.error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Register an uploaded original. Starts `pending` until the client confirms the upload. */
export async function createAsset(
  ctx: TenantContext,
  params: {
    objectKey: string;
    contentHash: string;
    mime: string;
    width?: number | null;
    height?: number | null;
    bytes?: number;
    metadata?: Record<string, unknown>;
  },
): Promise<StudioAsset> {
  const db = getKysely();
  const row = await db
    .insertInto("studio_assets")
    .values({
      user_id: ctx.userId,
      object_key: params.objectKey,
      content_hash: params.contentHash,
      mime: params.mime,
      width: params.width ?? null,
      height: params.height ?? null,
      bytes: params.bytes ?? 0,
      // Pass the object (not JSON.stringify): kysely-postgres-js serializes it to
      // jsonb once. A pre-stringified string would double-encode. Matches the
      // guarded style_profiles.profile / auto_dream_state.state_json pattern.
      metadata: (params.metadata ?? {}) as unknown as string,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  return mapAsset(row);
}

/** Mark a `pending` asset `ready` once the client confirms its presigned upload. */
export async function confirmAsset(
  ctx: TenantContext,
  assetId: string,
): Promise<StudioAsset | null> {
  const db = getKysely();
  const row = await db
    .updateTable("studio_assets")
    .set({ status: "ready", updated_at: sql`now()` })
    .where("id", "=", assetId)
    .where("user_id", "=", ctx.userId)
    .returningAll()
    .executeTakeFirst();
  return row ? mapAsset(row) : null;
}

export async function getAsset(ctx: TenantContext, assetId: string): Promise<StudioAsset | null> {
  const db = getKysely();
  const row = await db
    .selectFrom("studio_assets")
    .selectAll()
    .where("id", "=", assetId)
    .where("user_id", "=", ctx.userId)
    .executeTakeFirst();
  return row ? mapAsset(row) : null;
}

/** The result of appendEdit: the edit row + whether it was newly created (vs an idempotent hit). */
export interface AppendEditResult {
  edit: StudioEdit;
  created: boolean;
}

/**
 * Append an op to the asset's chain. Transactional: lock the asset row
 * (`FOR UPDATE`, so concurrent appends serialize), idempotency check, optimistic
 * head check, then insert + advance head. `created: false` on an idempotent retry
 * (the caller must NOT re-execute or re-charge); throws StaleParentError when the
 * parent is not the head.
 */
export async function appendEdit(
  ctx: TenantContext,
  params: {
    assetId: string;
    parentEditId: string | null;
    idempotencyKey: string;
    op: StudioOp;
    provider?: string | null;
    inputKey?: string | null;
    status?: StudioEditStatus;
  },
): Promise<AppendEditResult> {
  const db = getKysely();
  return db.transaction().execute(async (trx) => {
    // Lock the asset row so two concurrent appends on the same asset serialize
    // here (otherwise the optimistic head check is a stale snapshot under READ
    // COMMITTED and the chain can fork / a duplicate key can 23505).
    const asset = await trx
      .selectFrom("studio_assets")
      .selectAll()
      .where("id", "=", params.assetId)
      .where("user_id", "=", ctx.userId)
      .forUpdate()
      .executeTakeFirst();
    if (!asset) throw new StudioAssetNotFoundError(params.assetId);

    // Idempotent retry: a committed edit with this key wins, no re-charge.
    const existing = await trx
      .selectFrom("studio_edits")
      .selectAll()
      .where("asset_id", "=", params.assetId)
      .where("user_id", "=", ctx.userId)
      .where("idempotency_key", "=", params.idempotencyKey)
      .executeTakeFirst();
    if (existing) return { edit: mapEdit(existing), created: false };

    // Optimistic concurrency: the edit must build on the current head AND the
    // parent must already be a finished, output-bearing edit. Without the status
    // check, a second edit submitted while the parent is still running passes the
    // head check (head is advanced at append time) and then silently builds on the
    // ORIGINAL bytes (resolveInputKey falls back when outputKey is null). The
    // asset row is locked above, so reading the parent here is race-free.
    const head = asset.head_edit_id ?? null;
    const parent = params.parentEditId ?? null;
    if (parent !== head) throw new StaleParentError(parent, head);
    if (parent) {
      const parentEdit = await trx
        .selectFrom("studio_edits")
        .select(["status", "output_key"])
        .where("id", "=", parent)
        .where("user_id", "=", ctx.userId)
        .executeTakeFirst();
      if (!parentEdit || parentEdit.status !== "done" || !parentEdit.output_key) {
        throw new StaleParentError(parent, head);
      }
    }

    const inserted = await trx
      .insertInto("studio_edits")
      .values({
        asset_id: params.assetId,
        user_id: ctx.userId,
        parent_edit_id: parent,
        idempotency_key: params.idempotencyKey,
        op: params.op.op,
        op_spec_version: params.op.opSpecVersion ?? OP_SPEC_VERSION,
        // Pass the object (not JSON.stringify) so jsonb is single-encoded.
        params: params.op.params as unknown as string,
        provider: params.provider ?? null,
        input_key: params.inputKey ?? null,
        status: params.status ?? "pending",
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await trx
      .updateTable("studio_assets")
      .set({ head_edit_id: inserted.id, updated_at: sql`now()` })
      .where("id", "=", params.assetId)
      .where("user_id", "=", ctx.userId)
      .execute();

    return { edit: mapEdit(inserted), created: true };
  });
}

export async function markEditRunning(
  ctx: TenantContext,
  editId: string,
  provider: string,
): Promise<StudioEdit | null> {
  const db = getKysely();
  const row = await db
    .updateTable("studio_edits")
    .set({ status: "running", provider, updated_at: sql`now()` })
    .where("id", "=", editId)
    .where("user_id", "=", ctx.userId)
    .returningAll()
    .executeTakeFirst();
  return row ? mapEdit(row) : null;
}

export async function markEditDone(
  ctx: TenantContext,
  editId: string,
  result: {
    outputKey: string;
    previewKey?: string | null;
    costUsd?: number;
    identityScore?: number | null;
  },
): Promise<StudioEdit | null> {
  const db = getKysely();
  const row = await db
    .updateTable("studio_edits")
    .set({
      status: "done",
      output_key: result.outputKey,
      preview_key: result.previewKey ?? null,
      cost_usd: result.costUsd ?? 0,
      identity_score: result.identityScore ?? null,
      updated_at: sql`now()`,
    })
    .where("id", "=", editId)
    .where("user_id", "=", ctx.userId)
    .returningAll()
    .executeTakeFirst();
  return row ? mapEdit(row) : null;
}

export async function markEditFailed(
  ctx: TenantContext,
  editId: string,
  error: string,
): Promise<StudioEdit | null> {
  const db = getKysely();
  return db.transaction().execute(async (trx) => {
    const row = await trx
      .updateTable("studio_edits")
      .set({ status: "failed", error, updated_at: sql`now()` })
      .where("id", "=", editId)
      .where("user_id", "=", ctx.userId)
      .returningAll()
      .executeTakeFirst();
    if (!row) return null;
    // A failed edit must not stay the chain head: roll the head back to its
    // parent so head always reflects the last successful state. Conditional on
    // head still being this edit, so it is safe under concurrent appends.
    await trx
      .updateTable("studio_assets")
      .set({ head_edit_id: row.parent_edit_id, updated_at: sql`now()` })
      .where("id", "=", row.asset_id)
      .where("user_id", "=", ctx.userId)
      .where("head_edit_id", "=", editId)
      .execute();
    return mapEdit(row);
  });
}

/**
 * Record an identity-preservation score for an edit (e.g. the on-device Vision
 * check reported by the client after fetching the result). Scoped to the user.
 */
export async function recordIdentityScore(
  ctx: TenantContext,
  editId: string,
  score: number,
): Promise<StudioEdit | null> {
  const db = getKysely();
  const row = await db
    .updateTable("studio_edits")
    .set({ identity_score: score, updated_at: sql`now()` })
    .where("id", "=", editId)
    .where("user_id", "=", ctx.userId)
    .returningAll()
    .executeTakeFirst();
  return row ? mapEdit(row) : null;
}

export async function getEdit(ctx: TenantContext, editId: string): Promise<StudioEdit | null> {
  const db = getKysely();
  const row = await db
    .selectFrom("studio_edits")
    .selectAll()
    .where("id", "=", editId)
    .where("user_id", "=", ctx.userId)
    .executeTakeFirst();
  return row ? mapEdit(row) : null;
}

/** The full op chain for an asset, oldest first (the history strip + gallery). */
export async function listEdits(ctx: TenantContext, assetId: string): Promise<StudioEdit[]> {
  const db = getKysely();
  const rows = await db
    .selectFrom("studio_edits")
    .selectAll()
    .where("asset_id", "=", assetId)
    .where("user_id", "=", ctx.userId)
    .orderBy("created_at", "asc")
    .execute();
  return rows.map(mapEdit);
}
