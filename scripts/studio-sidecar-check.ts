/**
 * Real local check for the Studio sidecar path (dev verification, NOT CI).
 *
 * Points the engine at a running `nomos-studio-sidecar` (NOMOS_STUDIO_SIDECAR_URL,
 * default http://127.0.0.1:8799), seeds an asset, runs a `retouch` edit, and
 * asserts it routed to the deterministic sidecar (free) and produced output.
 *
 * Start the sidecar first:  (cd ../nomos-studio-sidecar && uv run nomos-studio-sidecar)
 * Run: pnpm tsx scripts/studio-sidecar-check.ts
 */

import "dotenv/config";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import type { TenantContext } from "../src/auth/tenant-context.ts";
import { closeDb, getKysely } from "../src/db/client.ts";
import { buildStudioEngine } from "../src/sdk/studio-mcp.ts";
import { createAsset } from "../src/studio/assets.ts";
import { ensureStudioSidecar, getStudioSidecarUrl } from "../src/studio/sidecar-launcher.ts";
import { getObjectStore, objectKey } from "../src/storage/object-store.ts";

const ctx: TenantContext = { orgId: "local", userId: "e2e-sidecar" };
const log = (...a: unknown[]) => console.log(...a);

async function main(): Promise<void> {
  process.env.NOMOS_STUDIO_SIDECAR_URL ??= "http://127.0.0.1:8799";
  const url = await ensureStudioSidecar();
  if (!url) {
    log(`SIDECAR not reachable at ${process.env.NOMOS_STUDIO_SIDECAR_URL}. Start it and retry.`);
    process.exit(1);
  }
  log(`sidecar url=${getStudioSidecarUrl()}`);

  const store = getObjectStore();
  // A noisy image so the bilateral smoothing is measurable.
  const noise = Buffer.alloc(256 * 256 * 3);
  for (let i = 0; i < noise.length; i++) noise[i] = Math.floor((i * 2654435761) % 256);
  const img = await sharp(noise, { raw: { width: 256, height: 256, channels: 3 } })
    .jpeg({ quality: 92 })
    .toBuffer();
  const key = objectKey("studio", randomUUID(), "original.jpg");
  await store.put(key, new Uint8Array(img), "image/jpeg");
  const asset = await createAsset(ctx, {
    objectKey: key,
    contentHash: "sidecar",
    mime: "image/jpeg",
    width: 256,
    height: 256,
    bytes: img.byteLength,
  });
  log(`asset ${asset.id}`);

  const engine = buildStudioEngine();
  const edit = await engine.edit(ctx, {
    assetId: asset.id,
    op: { op: "retouch", params: { strength: 0.9 } },
    parentEditId: asset.headEditId,
    idempotencyKey: randomUUID(),
  });
  const outBytes = edit.outputKey ? await store.get(edit.outputKey) : null;
  log(
    `RETOUCH edit=${edit.id} status=${edit.status} provider=${edit.provider} cost=$${edit.costUsd} out=${outBytes?.byteLength ?? 0}B`,
  );
  if (edit.status !== "done" || !outBytes) throw new Error("retouch produced no output");
  if (edit.provider !== "mediapipe-sidecar") {
    throw new Error(`expected provider mediapipe-sidecar, got ${edit.provider}`);
  }
  if (edit.costUsd !== 0) throw new Error(`expected $0 (deterministic), got ${edit.costUsd}`);

  const db = getKysely();
  await db.deleteFrom("studio_edits").where("user_id", "=", ctx.userId).execute();
  await db.deleteFrom("studio_assets").where("user_id", "=", ctx.userId).execute();
  await closeDb();
  log("SIDECAR OK; cleaned up");
}

main().catch(async (err) => {
  console.error(err);
  try {
    await closeDb();
  } catch {
    // ignore
  }
  process.exit(1);
});
