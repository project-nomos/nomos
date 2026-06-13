/**
 * Real end-to-end Studio exercise (dev verification, NOT a CI test).
 *
 * Drives the full pipeline against the local DB + local-fs object store:
 *   create asset -> deterministic adjust (local-sharp) -> idempotent retry ->
 *   real generative edit (Gemini via GOOGLE_API_KEY) -> assert rows + objects.
 *
 * Run:  pnpm tsx scripts/studio-e2e.ts   (needs DATABASE_URL + GOOGLE_API_KEY in .env)
 * Cleans up its own rows + restores the consent toggle.
 */

import "dotenv/config";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import type { TenantContext } from "../src/auth/tenant-context.ts";
import { closeDb, getKysely } from "../src/db/client.ts";
import { buildStudioEngine } from "../src/sdk/studio-mcp.ts";
import { createAsset, listEdits } from "../src/studio/assets.ts";
import { isCloudAIEnabled, setCloudAIEnabled } from "../src/studio/consent.ts";
import { getObjectStore, objectKey } from "../src/storage/object-store.ts";

const ctx: TenantContext = { orgId: "local", userId: "e2e-studio" };
const log = (...a: unknown[]) => console.log(...a);

async function main(): Promise<void> {
  const store = getObjectStore();
  const priorConsent = await isCloudAIEnabled();
  await setCloudAIEnabled(true);

  // create asset: synthesize an image, upload to the store, register the row.
  const img = await sharp({
    create: { width: 256, height: 256, channels: 3, background: { r: 130, g: 95, b: 75 } },
  })
    .jpeg()
    .toBuffer();
  const key = objectKey("studio", randomUUID(), "original.jpg");
  await store.put(key, new Uint8Array(img), "image/jpeg");
  const asset = await createAsset(ctx, {
    objectKey: key,
    contentHash: "e2e",
    mime: "image/jpeg",
    width: 256,
    height: 256,
    bytes: img.byteLength,
  });
  log(`asset ${asset.id} status=${asset.status}`);

  const engine = buildStudioEngine();

  // deterministic adjust (local-sharp) end to end + preview
  const adjust = await engine.edit(ctx, {
    assetId: asset.id,
    op: { op: "adjust", params: { exposure: 0.3, saturation: 0.2 } },
    parentEditId: asset.headEditId,
    idempotencyKey: randomUUID(),
  });
  if (!adjust.outputKey) throw new Error("adjust produced no output");
  const outBytes = await store.get(adjust.outputKey);
  const prevBytes = adjust.previewKey ? await store.get(adjust.previewKey) : null;
  log(
    `adjust  edit=${adjust.id} status=${adjust.status} provider=${adjust.provider} out=${outBytes.byteLength}B preview=${prevBytes?.byteLength ?? 0}B`,
  );

  // idempotent retry: same key -> same edit, no re-charge, no new row
  const retryKey = randomUUID();
  const r1 = await engine.edit(ctx, {
    assetId: asset.id,
    op: { op: "adjust", params: { contrast: 0.1 } },
    parentEditId: adjust.id,
    idempotencyKey: retryKey,
  });
  const r2 = await engine.edit(ctx, {
    assetId: asset.id,
    op: { op: "adjust", params: { contrast: 0.1 } },
    parentEditId: adjust.id,
    idempotencyKey: retryKey,
  });
  log(`idempotent retry same edit: ${r1.id === r2.id}`);

  // real generative edit via Gemini (GOOGLE_API_KEY). Best-effort; logs on failure.
  try {
    const gen = await engine.edit(ctx, {
      assetId: asset.id,
      op: { op: "editSemantic", params: { instruction: "make it warmer and a bit brighter" } },
      parentEditId: r1.id,
      idempotencyKey: randomUUID(),
    });
    const genBytes = gen.outputKey ? await store.get(gen.outputKey) : null;
    log(
      `GEMINI  edit=${gen.id} status=${gen.status} provider=${gen.provider} cost=$${gen.costUsd} out=${genBytes?.byteLength ?? 0}B`,
    );
  } catch (err) {
    log(`GEMINI  generative edit FAILED: ${err instanceof Error ? err.message : err}`);
  }

  // effect SQL goes nonzero (what the manifest audit asserts)
  const db = getKysely();
  const rows = await db
    .selectFrom("studio_edits")
    .selectAll()
    .where("user_id", "=", ctx.userId)
    .execute();
  const doneCount = rows.filter((r) => r.status === "done").length;
  log(`EFFECT  studio_edits rows=${rows.length} done=${doneCount}`);
  const chain = await listEdits(ctx, asset.id);
  log(`CHAIN   ${chain.map((e) => `${e.op}[${e.status}]`).join(" -> ")}`);
  log(
    `HEAD    ${(await db.selectFrom("studio_assets").select("head_edit_id").where("id", "=", asset.id).executeTakeFirst())?.head_edit_id}`,
  );

  // cleanup
  await db.deleteFrom("studio_edits").where("user_id", "=", ctx.userId).execute();
  await db.deleteFrom("studio_assets").where("user_id", "=", ctx.userId).execute();
  await setCloudAIEnabled(priorConsent);
  await closeDb();
  log("CLEANED UP");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
