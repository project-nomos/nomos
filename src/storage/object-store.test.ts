import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertSafeKey,
  getObjectStore,
  LocalFsObjectStore,
  objectKey,
  resetObjectStoreForTest,
} from "./object-store.ts";

describe("object key safety", () => {
  it("builds an org-scoped key", () => {
    expect(objectKey("studio", "abc123", "original.jpg")).toBe(
      "org/local/studio/abc123/original.jpg",
    );
  });

  it("rejects traversal, absolute, and bad keys", () => {
    expect(() => assertSafeKey("../etc/passwd")).toThrow();
    expect(() => assertSafeKey("/abs/path")).toThrow();
    expect(() => assertSafeKey("a\\b")).toThrow();
    expect(() => assertSafeKey("a/../b")).toThrow();
    expect(() => assertSafeKey("trailing/")).toThrow();
    expect(() => assertSafeKey("")).toThrow();
    expect(() => assertSafeKey("ok/key_1.jpg")).not.toThrow();
  });
});

describe("LocalFsObjectStore", () => {
  let dir: string;
  let store: LocalFsObjectStore;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "nomos-objstore-"));
    store = new LocalFsObjectStore(dir);
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("round-trips bytes and reports size + content hash", async () => {
    const bytes = new TextEncoder().encode("hello studio");
    const res = await store.put("org/local/studio/a/original.jpg", bytes, "image/jpeg");
    expect(res.size).toBe(bytes.byteLength);
    expect(res.contentHash).toMatch(/^[a-f0-9]{64}$/);
    const got = await store.get("org/local/studio/a/original.jpg");
    expect(new TextDecoder().decode(got)).toBe("hello studio");
  });

  it("head returns stat with content type, or null when absent", async () => {
    await store.put("org/local/studio/a/x.png", new Uint8Array([1, 2, 3]), "image/png");
    const stat = await store.head("org/local/studio/a/x.png");
    expect(stat?.size).toBe(3);
    expect(stat?.contentType).toBe("image/png");
    expect(await store.head("org/local/studio/a/missing.png")).toBeNull();
  });

  it("delete removes the object and is idempotent", async () => {
    await store.put("org/local/studio/a/y.jpg", new Uint8Array([9]));
    await store.delete("org/local/studio/a/y.jpg");
    expect(await store.head("org/local/studio/a/y.jpg")).toBeNull();
    await expect(store.delete("org/local/studio/a/y.jpg")).resolves.toBeUndefined();
  });

  it("lists keys under a prefix (and excludes content-type sidecars)", async () => {
    await store.put("org/local/studio/a/1.jpg", new Uint8Array([1]), "image/jpeg");
    await store.put("org/local/studio/a/2.jpg", new Uint8Array([2]), "image/jpeg");
    await store.put("org/local/studio/b/3.jpg", new Uint8Array([3]));
    const keys = await store.list("org/local/studio/a/");
    expect(keys).toEqual(["org/local/studio/a/1.jpg", "org/local/studio/a/2.jpg"]);
  });

  it("refuses keys that escape the base dir", async () => {
    await expect(store.get("../../../etc/hosts")).rejects.toThrow();
  });

  it("presign returns a file:// url in dev", async () => {
    const put = await store.presignPut("org/local/studio/a/z.jpg", { contentType: "image/jpeg" });
    expect(put.method).toBe("PUT");
    expect(put.url.startsWith("file://")).toBe(true);
    expect(put.expiresAt).toBeGreaterThan(0);
  });
});

describe("getObjectStore factory", () => {
  const prev = { ...process.env };
  afterEach(() => {
    process.env = { ...prev };
    resetObjectStoreForTest();
  });

  it("returns the local-fs driver by default", () => {
    process.env.NOMOS_OBJECT_STORE_DRIVER = "local";
    resetObjectStoreForTest();
    expect(getObjectStore()).toBeInstanceOf(LocalFsObjectStore);
  });

  it("throws a clear error for the not-yet-wired GCS driver (GCP-only)", () => {
    process.env.NOMOS_OBJECT_STORE_DRIVER = "gcs";
    resetObjectStoreForTest();
    expect(() => getObjectStore()).toThrow(/@google-cloud\/storage/);
  });
});
