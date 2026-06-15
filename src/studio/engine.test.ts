import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./assets.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./assets.ts")>();
  return {
    ...actual,
    getAsset: vi.fn(),
    confirmAsset: vi.fn(),
    getEdit: vi.fn(),
    appendEdit: vi.fn(),
    markEditRunning: vi.fn(),
    markEditDone: vi.fn(),
    markEditFailed: vi.fn(),
  };
});

import type { TenantContext } from "../auth/tenant-context.ts";
import type { ObjectStore } from "../storage/object-store.ts";
import * as assets from "./assets.ts";
import type { StudioAsset, StudioEdit } from "./assets.ts";
import { ConsentRequiredError } from "./consent.ts";
import { NoProviderError, StudioEngine, type StudioProvider } from "./engine.ts";
import { IdentityDriftError } from "./identity-gate.ts";

const ctx = { orgId: "local", userId: "u1" } as TenantContext;

function fakeAsset(over: Partial<StudioAsset> = {}): StudioAsset {
  return {
    id: "a1",
    userId: "u1",
    objectKey: "org/local/studio/a1/original.jpg",
    contentHash: "h",
    mime: "image/jpeg",
    width: 1024,
    height: 1024,
    bytes: 1000,
    status: "ready",
    headEditId: null,
    metadata: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

function fakeEdit(over: Partial<StudioEdit> = {}): StudioEdit {
  return {
    id: "e1",
    assetId: "a1",
    userId: "u1",
    parentEditId: null,
    idempotencyKey: "k1",
    op: "editSemantic",
    opSpecVersion: 1,
    params: {},
    provider: "fake",
    inputKey: "org/local/studio/a1/original.jpg",
    outputKey: null,
    previewKey: null,
    status: "pending",
    costUsd: 0,
    identityScore: null,
    error: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

function fakeStore(): ObjectStore {
  return {
    get: vi.fn(async () => Buffer.from([1, 2, 3])),
    put: vi.fn(async (key: string) => ({ key, size: 1, contentHash: "h" })),
    head: vi.fn(async () => null),
    delete: vi.fn(async () => {}),
    list: vi.fn(async () => []),
    presignPut: vi.fn(async (key: string) => ({
      method: "PUT" as const,
      url: "file://x",
      key,
      expiresAt: 1,
    })),
    presignGet: vi.fn(async () => ({ url: "file://x", expiresAt: 1 })),
  };
}

function fakeProvider(over: Partial<StudioProvider> = {}): StudioProvider {
  return {
    name: "fake",
    kind: "generative",
    supports: () => true,
    execute: vi.fn(async () => ({
      bytes: new Uint8Array([9]),
      mime: "image/jpeg",
      costUsd: 0.039,
      provider: "fake",
    })),
    ...over,
  };
}

beforeEach(() => {
  vi.mocked(assets.getAsset).mockReset();
  vi.mocked(assets.confirmAsset).mockReset();
  vi.mocked(assets.getEdit).mockReset();
  vi.mocked(assets.appendEdit).mockReset();
  vi.mocked(assets.markEditRunning).mockReset();
  vi.mocked(assets.markEditDone).mockReset();
  vi.mocked(assets.markEditFailed).mockReset();
});

describe("StudioEngine.edit", () => {
  it("runs a generative op end to end: consent, provider, identity gate, store, record", async () => {
    vi.mocked(assets.getAsset).mockResolvedValue(fakeAsset());
    vi.mocked(assets.appendEdit).mockResolvedValue({
      edit: fakeEdit({ status: "pending" }),
      created: true,
    });
    vi.mocked(assets.markEditRunning).mockResolvedValue(fakeEdit({ status: "running" }));
    vi.mocked(assets.markEditDone).mockResolvedValue(
      fakeEdit({ status: "done", outputKey: "out.jpg", identityScore: 0.97 }),
    );
    const store = fakeStore();
    const provider = fakeProvider();
    const identityGate = vi.fn(async () => ({ checked: true, score: 0.97, passed: true }));

    const engine = new StudioEngine({
      providers: [provider],
      store,
      isCloudAIEnabled: async () => true,
      identityGate,
    });

    const edit = await engine.edit(ctx, {
      assetId: "a1",
      op: { op: "editSemantic", params: { instruction: "warm it up" } },
      parentEditId: null,
      idempotencyKey: "k1",
    });

    expect(edit.status).toBe("done");
    expect(provider.execute).toHaveBeenCalledOnce();
    expect(identityGate).toHaveBeenCalledOnce(); // editSemantic is high identity-risk
    expect(store.put).toHaveBeenCalled();
    expect(assets.markEditDone).toHaveBeenCalled();
  });

  it("blocks a generative op when cloud-AI consent is off, before any row is created", async () => {
    vi.mocked(assets.getAsset).mockResolvedValue(fakeAsset());
    const provider = fakeProvider();
    const engine = new StudioEngine({
      providers: [provider],
      store: fakeStore(),
      isCloudAIEnabled: async () => false,
    });
    await expect(
      engine.edit(ctx, {
        assetId: "a1",
        op: { op: "editSemantic", params: { instruction: "x" } },
        parentEditId: null,
        idempotencyKey: "k",
      }),
    ).rejects.toBeInstanceOf(ConsentRequiredError);
    expect(assets.appendEdit).not.toHaveBeenCalled();
    expect(provider.execute).not.toHaveBeenCalled();
  });

  it("does not gate a deterministic op on consent", async () => {
    vi.mocked(assets.getAsset).mockResolvedValue(fakeAsset());
    vi.mocked(assets.appendEdit).mockResolvedValue({
      edit: fakeEdit({ op: "adjust", status: "pending" }),
      created: true,
    });
    vi.mocked(assets.markEditRunning).mockResolvedValue(
      fakeEdit({ op: "adjust", status: "running" }),
    );
    vi.mocked(assets.markEditDone).mockResolvedValue(
      fakeEdit({ op: "adjust", status: "done", outputKey: "out.jpg" }),
    );
    const provider = fakeProvider({ kind: "deterministic" });
    const identityGate = vi.fn(async () => ({ checked: false, score: null, passed: true }));
    const engine = new StudioEngine({
      providers: [provider],
      store: fakeStore(),
      isCloudAIEnabled: async () => false, // off, but the provider is deterministic
      identityGate,
    });
    const edit = await engine.edit(ctx, {
      assetId: "a1",
      op: { op: "adjust", params: { exposure: 0.3 } },
      parentEditId: null,
      idempotencyKey: "k2",
    });
    expect(edit.status).toBe("done");
    expect(identityGate).not.toHaveBeenCalled(); // adjust is identityRisk none
    expect(provider.execute).toHaveBeenCalled();
  });

  it("deviceRender feeds the client-supplied bytes to the provider (not the chain source)", async () => {
    vi.mocked(assets.getAsset).mockResolvedValue(fakeAsset());
    vi.mocked(assets.appendEdit).mockResolvedValue({
      edit: fakeEdit({ op: "deviceRender", status: "pending" }),
      created: true,
    });
    vi.mocked(assets.markEditRunning).mockResolvedValue(
      fakeEdit({ op: "deviceRender", status: "running" }),
    );
    vi.mocked(assets.markEditDone).mockResolvedValue(
      fakeEdit({ op: "deviceRender", status: "done", outputKey: "out.jpg" }),
    );
    const store = fakeStore();
    const provider = fakeProvider({ kind: "deterministic" });
    const rendered = new Uint8Array([42, 43, 44]);
    const engine = new StudioEngine({
      providers: [provider],
      store,
      isCloudAIEnabled: async () => false,
    });

    const edit = await engine.edit(ctx, {
      assetId: "a1",
      op: { op: "deviceRender", params: { tool: "makeup" } },
      parentEditId: null,
      idempotencyKey: "kd",
      inlineInputBytes: rendered,
    });

    expect(edit.status).toBe("done");
    // The provider sees the uploaded render, and the source object is never fetched
    // (identityRisk none + inline bytes present).
    expect(provider.execute).toHaveBeenCalledWith(
      expect.objectContaining({ op: "deviceRender" }),
      expect.objectContaining({ bytes: rendered }),
    );
    expect(store.get).not.toHaveBeenCalled();
  });

  it("deviceRender without inline bytes fails the edit", async () => {
    vi.mocked(assets.getAsset).mockResolvedValue(fakeAsset());
    vi.mocked(assets.appendEdit).mockResolvedValue({
      edit: fakeEdit({ op: "deviceRender", status: "pending" }),
      created: true,
    });
    vi.mocked(assets.markEditRunning).mockResolvedValue(
      fakeEdit({ op: "deviceRender", status: "running" }),
    );
    vi.mocked(assets.markEditFailed).mockResolvedValue(
      fakeEdit({ op: "deviceRender", status: "failed" }),
    );
    const engine = new StudioEngine({
      providers: [fakeProvider({ kind: "deterministic" })],
      store: fakeStore(),
    });
    await expect(
      engine.edit(ctx, {
        assetId: "a1",
        op: { op: "deviceRender", params: { tool: "makeup" } },
        parentEditId: null,
        idempotencyKey: "kd2",
      }),
    ).rejects.toThrow(/requires input_image/);
    expect(assets.markEditFailed).toHaveBeenCalled();
  });

  it("throws NoProviderError without creating a row when no provider supports the op", async () => {
    vi.mocked(assets.getAsset).mockResolvedValue(fakeAsset());
    const engine = new StudioEngine({ providers: [], store: fakeStore() });
    await expect(
      engine.edit(ctx, {
        assetId: "a1",
        op: { op: "adjust", params: {} },
        parentEditId: null,
        idempotencyKey: "k",
      }),
    ).rejects.toBeInstanceOf(NoProviderError);
    expect(assets.appendEdit).not.toHaveBeenCalled();
  });

  it("marks the edit failed and rethrows when the identity gate rejects", async () => {
    vi.mocked(assets.getAsset).mockResolvedValue(fakeAsset());
    vi.mocked(assets.appendEdit).mockResolvedValue({
      edit: fakeEdit({ status: "pending" }),
      created: true,
    });
    vi.mocked(assets.markEditRunning).mockResolvedValue(fakeEdit({ status: "running" }));
    vi.mocked(assets.markEditFailed).mockResolvedValue(fakeEdit({ status: "failed" }));
    const provider = fakeProvider();
    const engine = new StudioEngine({
      providers: [provider],
      store: fakeStore(),
      isCloudAIEnabled: async () => true,
      identityGate: vi.fn(async () => {
        throw new IdentityDriftError(0.4, 0.6);
      }),
    });
    await expect(
      engine.edit(ctx, {
        assetId: "a1",
        op: { op: "editSemantic", params: { instruction: "x" } },
        parentEditId: null,
        idempotencyKey: "k3",
      }),
    ).rejects.toBeInstanceOf(IdentityDriftError);
    expect(assets.markEditFailed).toHaveBeenCalled();
  });

  it("short-circuits an idempotent retry (created=false), never re-running the provider", async () => {
    vi.mocked(assets.getAsset).mockResolvedValue(fakeAsset());
    vi.mocked(assets.appendEdit).mockResolvedValue({
      edit: fakeEdit({ status: "running", outputKey: null }),
      created: false,
    });
    const provider = fakeProvider();
    const engine = new StudioEngine({
      providers: [provider],
      store: fakeStore(),
      isCloudAIEnabled: async () => true,
    });
    const edit = await engine.edit(ctx, {
      assetId: "a1",
      op: { op: "editSemantic", params: { instruction: "x" } },
      parentEditId: null,
      idempotencyKey: "k1",
    });
    expect(edit.status).toBe("running"); // returned the in-flight row as-is
    expect(provider.execute).not.toHaveBeenCalled();
  });
});
