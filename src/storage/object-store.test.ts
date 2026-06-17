import { promises as fs } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertSafeKey,
  getObjectStore,
  handleBlobRequest,
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

describe("local-fs blob HTTP serving (dev presign)", () => {
  const prev = { ...process.env };
  const base = "http://localhost:8767";
  let dir = "";

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "blob-"));
    process.env.NOMOS_OBJECT_STORE_DRIVER = "local";
    process.env.NOMOS_OBJECT_STORE_PATH = dir;
    process.env.NOMOS_OBJECT_STORE_PUBLIC_URL = base;
    resetObjectStoreForTest();
  });
  afterEach(async () => {
    process.env = { ...prev };
    resetObjectStoreForTest();
    await fs.rm(dir, { recursive: true, force: true });
  });

  const fakeReq = (method: string, url: string, body?: Buffer): IncomingMessage => {
    const r = Readable.from(body ? [body] : []) as unknown as IncomingMessage;
    (r as { url: string }).url = url;
    (r as { method: string }).method = method;
    (r as { headers: Record<string, string> }).headers = { "content-type": "image/jpeg" };
    return r;
  };
  const fakeRes = () => {
    const res = {
      statusCode: 0,
      headersSent: false,
      body: undefined as Buffer | string | undefined,
      writeHead(code: number) {
        this.statusCode = code;
        this.headersSent = true;
        return this;
      },
      end(chunk?: Buffer | string) {
        this.body = chunk;
        return this;
      },
    };
    return res as unknown as ServerResponse & typeof res;
  };

  it("presigns an HTTP blob URL and round-trips PUT then GET", async () => {
    const store = getObjectStore();
    const key = "org/local/studio/a/orig.jpg";
    const put = await store.presignPut(key, { contentType: "image/jpeg" });
    expect(put.url.startsWith(`${base}/studio-blob/${key}?`)).toBe(true);

    const resPut = fakeRes();
    expect(
      await handleBlobRequest(
        fakeReq("PUT", put.url.slice(base.length), Buffer.from([1, 2, 3])),
        resPut,
      ),
    ).toBe(true);
    expect(resPut.statusCode).toBe(200);

    const get = await store.presignGet(key);
    const resGet = fakeRes();
    expect(await handleBlobRequest(fakeReq("GET", get.url.slice(base.length)), resGet)).toBe(true);
    expect(resGet.statusCode).toBe(200);
    expect(Buffer.from(resGet.body as Buffer).equals(Buffer.from([1, 2, 3]))).toBe(true);
  });

  it("rejects a bad signature with 403", async () => {
    const exp = Date.now() + 10_000;
    const res = fakeRes();
    await handleBlobRequest(
      fakeReq(
        "PUT",
        `/studio-blob/org/local/studio/a/x.jpg?exp=${exp}&sig=deadbeef`,
        Buffer.from([1]),
      ),
      res,
    );
    expect(res.statusCode).toBe(403);
  });

  it("ignores non-blob requests (returns false, body untouched)", async () => {
    const res = fakeRes();
    expect(await handleBlobRequest(fakeReq("POST", "/nomos.MobileApi/Chat"), res)).toBe(false);
    expect(res.headersSent).toBe(false);
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
