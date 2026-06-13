import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockDb } from "../db/test-helpers.ts";

const { db, addResult, getQueries, reset } = createMockDb();
vi.mock("../db/client.ts", () => ({ getKysely: () => db }));

import type { TenantContext } from "../auth/tenant-context.ts";
import type { ObjectStore } from "../storage/object-store.ts";
import { runStudioGcForUser } from "./gc.ts";

const ctx = { orgId: "local", userId: "u1" } as TenantContext;

function fakeStore(): ObjectStore {
  return {
    get: vi.fn(),
    put: vi.fn(),
    head: vi.fn(),
    delete: vi.fn(async () => {}),
    list: vi.fn(),
    presignPut: vi.fn(),
    presignGet: vi.fn(),
  } as unknown as ObjectStore;
}

beforeEach(() => reset());

describe("runStudioGcForUser", () => {
  it("expires unconfirmed uploads and aged intermediates, dropping their objects", async () => {
    addResult([{ id: "a1", object_key: "org/local/studio/a1/original.jpg" }]); // pending assets
    addResult([]); // UPDATE pending
    addResult([{ id: "e1", output_key: "out1.jpg", preview_key: "prev1.jpg" }]); // intermediates
    addResult([]); // UPDATE intermediates
    const store = fakeStore();
    const r = await runStudioGcForUser(ctx, { store, now: Date.now() });
    expect(r.assetsExpired).toBe(1);
    expect(r.editsExpired).toBe(1);
    expect(r.objectsDeleted).toBe(3); // original + output + preview
    expect(store.delete).toHaveBeenCalledWith("org/local/studio/a1/original.jpg");
    expect(store.delete).toHaveBeenCalledWith("out1.jpg");
    expect(store.delete).toHaveBeenCalledWith("prev1.jpg");
    // Regression: the pending sweep must only reap assets with NO edits, so an
    // in-use original (head_edit_id set) is never deleted.
    expect(getQueries().some((q) => /"head_edit_id" is null/i.test(q.sql))).toBe(true);
  });

  it("is a no-op when nothing is expirable", async () => {
    addResult([]); // pending: none
    addResult([]); // intermediates: none
    const store = fakeStore();
    const r = await runStudioGcForUser(ctx, { store });
    expect(r).toEqual({ assetsExpired: 0, editsExpired: 0, objectsDeleted: 0 });
    expect(store.delete).not.toHaveBeenCalled();
  });

  it("scopes its queries to the user", async () => {
    addResult([]);
    addResult([]);
    await runStudioGcForUser(ctx, { store: fakeStore() });
    expect(getQueries().some((q) => q.parameters.includes("u1"))).toBe(true);
  });
});
