/**
 * Object storage for Studio blobs (originals, edit results, previews).
 *
 * Two drivers behind one interface:
 *   - local-fs (`NOMOS_OBJECT_STORE_DRIVER=local`, default): a directory on disk.
 *     Lets power-user dev and `pnpm eval:agent` run with no cloud bucket. Presign
 *     returns a `file://` URL (dev-only; the engine reads/writes via put/get).
 *   - GCS (`NOMOS_OBJECT_STORE_DRIVER=gcs`): Google Cloud Storage, the prod driver.
 *     Same GCP stack as Vertex (ADC / workload identity, no AWS), V4 signed URLs.
 *     Lands with `@google-cloud/storage` when hosted infra is built (see
 *     the design doc "Build prerequisites").
 *
 * All keys are org-scoped (`org/<NOMOS_ORG_ID>/...`) so GDPR delete can drop a
 * whole customer prefix, matching the per-customer storage prefix in HOSTED_PLAN.
 * Blobs never transit gRPC: clients use presigned PUT/GET.
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createLogger } from "../lib/logger.ts";

const log = createLogger("object-store");

export interface PutResult {
  key: string;
  size: number;
  contentHash: string;
}

export interface ObjectStat {
  key: string;
  size: number;
  contentType?: string;
}

export interface PresignedPut {
  method: "PUT";
  url: string;
  key: string;
  expiresAt: number;
}

export interface PresignedGet {
  url: string;
  expiresAt: number;
}

export interface ObjectStore {
  put(key: string, bytes: Uint8Array, contentType?: string): Promise<PutResult>;
  get(key: string): Promise<Buffer>;
  head(key: string): Promise<ObjectStat | null>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
  presignPut(
    key: string,
    opts?: { contentType?: string; ttlSeconds?: number },
  ): Promise<PresignedPut>;
  presignGet(key: string, opts?: { ttlSeconds?: number }): Promise<PresignedGet>;
}

const KEY_RE = /^[A-Za-z0-9._\-/]+$/;
const MAX_KEY_LEN = 1024;

/** Reject traversal, absolute, backslash, null-byte, and out-of-charset keys. */
export function assertSafeKey(key: string): void {
  if (!key || key.length > MAX_KEY_LEN) {
    throw new Error(`Invalid object key length: ${JSON.stringify(key)}`);
  }
  if (
    key.startsWith("/") ||
    key.includes("..") ||
    key.includes("\\") ||
    key.includes("\0") ||
    key.endsWith("/") ||
    !KEY_RE.test(key)
  ) {
    throw new Error(`Unsafe object key: ${JSON.stringify(key)}`);
  }
}

export function resolveOrgId(): string {
  return process.env.NOMOS_ORG_ID ?? "local";
}

/** Build an org-scoped key, e.g. objectKey("studio", id, "original.jpg"). */
export function objectKey(...parts: string[]): string {
  const key = ["org", resolveOrgId(), ...parts].join("/");
  assertSafeKey(key);
  return key;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export class LocalFsObjectStore implements ObjectStore {
  constructor(private readonly baseDir: string) {}

  private pathFor(key: string): string {
    assertSafeKey(key);
    const baseAbs = path.resolve(this.baseDir);
    const abs = path.resolve(baseAbs, key);
    if (abs !== baseAbs && !abs.startsWith(baseAbs + path.sep)) {
      throw new Error(`Key escapes base dir: ${JSON.stringify(key)}`);
    }
    return abs;
  }

  async put(key: string, bytes: Uint8Array, contentType?: string): Promise<PutResult> {
    const p = this.pathFor(key);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, bytes);
    if (contentType) await fs.writeFile(`${p}.ct`, contentType, "utf8");
    return { key, size: bytes.byteLength, contentHash: sha256(bytes) };
  }

  async get(key: string): Promise<Buffer> {
    return fs.readFile(this.pathFor(key));
  }

  async head(key: string): Promise<ObjectStat | null> {
    const p = this.pathFor(key);
    try {
      const st = await fs.stat(p);
      let contentType: string | undefined;
      try {
        contentType = (await fs.readFile(`${p}.ct`, "utf8")) || undefined;
      } catch {
        contentType = undefined;
      }
      return { key, size: st.size, contentType };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    const p = this.pathFor(key);
    await fs.rm(p, { force: true });
    await fs.rm(`${p}.ct`, { force: true });
  }

  async list(prefix: string): Promise<string[]> {
    const root = path.resolve(this.baseDir);
    const out: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      let entries: import("node:fs").Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
        throw err;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          await walk(full);
        } else if (e.isFile() && !full.endsWith(".ct")) {
          const key = path.relative(root, full).split(path.sep).join("/");
          if (key.startsWith(prefix)) out.push(key);
        }
      }
    };
    await walk(root);
    return out.sort();
  }

  async presignPut(
    key: string,
    opts?: { contentType?: string; ttlSeconds?: number },
  ): Promise<PresignedPut> {
    const p = this.pathFor(key);
    await fs.mkdir(path.dirname(p), { recursive: true });
    return {
      method: "PUT",
      url: pathToFileURL(p).href,
      key,
      expiresAt: Date.now() + (opts?.ttlSeconds ?? 900) * 1000,
    };
  }

  async presignGet(key: string, opts?: { ttlSeconds?: number }): Promise<PresignedGet> {
    return {
      url: pathToFileURL(this.pathFor(key)).href,
      expiresAt: Date.now() + (opts?.ttlSeconds ?? 900) * 1000,
    };
  }
}

let singleton: ObjectStore | null = null;

function resolveDriver(): string {
  return (process.env.NOMOS_OBJECT_STORE_DRIVER ?? "local").trim().toLowerCase();
}

export function isObjectStoreConfigured(): boolean {
  const driver = resolveDriver();
  if (driver === "local") return true;
  if (driver === "gcs") return Boolean(process.env.NOMOS_OBJECT_STORE_BUCKET);
  return false;
}

export function getObjectStore(): ObjectStore {
  if (singleton) return singleton;
  const driver = resolveDriver();

  if (driver === "gcs") {
    // Prod driver: Google Cloud Storage via @google-cloud/storage (ADC /
    // workload identity, V4 signed URLs). Lands with the hosted infra; see
    // the design doc "Build prerequisites". GCP-only, no AWS.
    throw new Error(
      "NOMOS_OBJECT_STORE_DRIVER=gcs is not wired yet (add @google-cloud/storage, Phase 1a prod). Use 'local' for dev/eval.",
    );
  }
  if (driver !== "local") {
    throw new Error(`Unknown NOMOS_OBJECT_STORE_DRIVER: ${driver}. Use 'local' or 'gcs'.`);
  }

  const baseDir =
    process.env.NOMOS_OBJECT_STORE_PATH ?? path.join(os.tmpdir(), "nomos-object-store");
  singleton = new LocalFsObjectStore(baseDir);
  log.info({ baseDir }, "object store: local-fs driver");
  return singleton;
}

/** Test hook: drop the cached singleton so env changes take effect. */
export function resetObjectStoreForTest(): void {
  singleton = null;
}
