import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockDb } from "../db/test-helpers.ts";

const { db, addResult, getQueries, reset } = createMockDb();
vi.mock("../db/client.ts", () => ({ getKysely: () => db }));

import type { TenantContext } from "../auth/tenant-context.ts";
import {
  appendEdit,
  createAsset,
  getAsset,
  listEdits,
  markEditDone,
  recordIdentityScore,
  StaleParentError,
  StudioAssetNotFoundError,
} from "./assets.ts";
import { validateOp } from "./ops.ts";

const ctx = { orgId: "local", userId: "u1" } as TenantContext;

function assetRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "a1",
    user_id: "u1",
    object_key: "org/local/studio/a1/original.jpg",
    content_hash: "h",
    mime: "image/jpeg",
    width: 1024,
    height: 1024,
    bytes: 1000,
    status: "ready",
    head_edit_id: null,
    metadata: {},
    created_at: new Date(),
    updated_at: new Date(),
    ...over,
  };
}

function editRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "e1",
    asset_id: "a1",
    user_id: "u1",
    parent_edit_id: null,
    idempotency_key: "k1",
    op: "adjust",
    op_spec_version: 1,
    params: { exposure: 0.3 },
    provider: null,
    input_key: null,
    output_key: null,
    preview_key: null,
    status: "pending",
    cost_usd: 0,
    identity_score: null,
    error: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...over,
  };
}

const sqlOf = (re: RegExp) => getQueries().some((q) => re.test(q.sql));

beforeEach(() => reset());

describe("createAsset", () => {
  it("inserts a pending asset scoped to the user", async () => {
    addResult([assetRow({ status: "pending" })]);
    const asset = await createAsset(ctx, {
      objectKey: "org/local/studio/a1/original.jpg",
      contentHash: "h",
      mime: "image/jpeg",
      bytes: 1000,
    });
    expect(asset.status).toBe("pending");
    expect(asset.objectKey).toBe("org/local/studio/a1/original.jpg");
    const insert = getQueries().find((q) => /insert into "studio_assets"/i.test(q.sql));
    expect(insert?.parameters).toContain("u1");
  });
});

describe("getAsset", () => {
  it("maps the row and filters by user_id", async () => {
    addResult([assetRow()]);
    const asset = await getAsset(ctx, "a1");
    expect(asset?.id).toBe("a1");
    const select = getQueries().find((q) => /from "studio_assets"/i.test(q.sql));
    expect(select?.parameters).toContain("u1");
  });

  it("returns null when absent", async () => {
    addResult([]);
    expect(await getAsset(ctx, "missing")).toBeNull();
  });
});

describe("appendEdit", () => {
  it("appends on a matching head and advances the chain", async () => {
    addResult([assetRow({ head_edit_id: null })]); // SELECT asset
    addResult([]); // SELECT existing edit (none)
    addResult([editRow({ id: "e1" })]); // INSERT edit
    addResult([]); // UPDATE head
    const op = validateOp({ op: "adjust", params: { exposure: 0.3 } });
    const { edit, created } = await appendEdit(ctx, {
      assetId: "a1",
      parentEditId: null,
      idempotencyKey: "k1",
      op,
    });
    expect(created).toBe(true);
    expect(edit.id).toBe("e1");
    expect(edit.op).toBe("adjust");
    expect(sqlOf(/insert into "studio_edits"/i)).toBe(true);
    expect(sqlOf(/update "studio_assets"/i)).toBe(true);
    expect(sqlOf(/for update/i)).toBe(true); // asset row locked
  });

  it("is idempotent: a committed key returns the existing edit, no insert", async () => {
    addResult([assetRow()]); // SELECT asset
    addResult([editRow({ id: "ePrev", idempotency_key: "k1" })]); // SELECT existing edit
    const op = validateOp({ op: "adjust", params: {} });
    const { edit, created } = await appendEdit(ctx, {
      assetId: "a1",
      parentEditId: null,
      idempotencyKey: "k1",
      op,
    });
    expect(created).toBe(false);
    expect(edit.id).toBe("ePrev");
    expect(sqlOf(/insert into "studio_edits"/i)).toBe(false);
  });

  it("rejects a stale parent (a concurrent edit advanced the head)", async () => {
    addResult([assetRow({ head_edit_id: "eHEAD" })]);
    addResult([]); // no existing edit
    const op = validateOp({ op: "adjust", params: {} });
    await expect(
      appendEdit(ctx, { assetId: "a1", parentEditId: null, idempotencyKey: "k2", op }),
    ).rejects.toBeInstanceOf(StaleParentError);
    expect(sqlOf(/insert into "studio_edits"/i)).toBe(false);
  });

  it("throws when the asset does not exist for this user", async () => {
    addResult([]); // SELECT asset -> none
    const op = validateOp({ op: "adjust", params: {} });
    await expect(
      appendEdit(ctx, { assetId: "missing", parentEditId: null, idempotencyKey: "k", op }),
    ).rejects.toBeInstanceOf(StudioAssetNotFoundError);
  });
});

describe("markEditDone + listEdits", () => {
  it("records the result blob keys and cost", async () => {
    addResult([editRow({ id: "e1", status: "done", output_key: "out.jpg", preview_key: "p.jpg" })]);
    const edit = await markEditDone(ctx, "e1", {
      outputKey: "out.jpg",
      previewKey: "p.jpg",
      costUsd: 0.039,
    });
    expect(edit?.status).toBe("done");
    expect(edit?.outputKey).toBe("out.jpg");
    expect(edit?.previewKey).toBe("p.jpg");
  });

  it("returns the chain oldest-first, scoped to the user", async () => {
    addResult([editRow({ id: "e1" }), editRow({ id: "e2" })]);
    const edits = await listEdits(ctx, "a1");
    expect(edits.map((e) => e.id)).toEqual(["e1", "e2"]);
    const select = getQueries().find((q) => /from "studio_edits"/i.test(q.sql));
    expect(select?.parameters).toContain("u1");
  });

  it("recordIdentityScore writes the score scoped to the user", async () => {
    addResult([editRow({ id: "e1", identity_score: 0.97 })]);
    const edit = await recordIdentityScore(ctx, "e1", 0.97);
    expect(edit?.identityScore).toBe(0.97);
    const update = getQueries().find((q) => /update "studio_edits"/i.test(q.sql));
    expect(update?.parameters).toContain("u1");
  });
});
