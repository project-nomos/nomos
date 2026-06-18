/**
 * Real gRPC wire check for the Studio deviceRender path (dev verification, NOT CI).
 *
 * Boots the ACTUAL grpc-js MobileApi server (the one iOS talks to) on a test port
 * in power-user mode (no JWT -> LOCAL_TENANT), then over a real grpc-js client:
 *   - StudioEdit op=deviceRender + input_image bytes -> asserts a `done` event,
 *     a stored JPEG output, and a studio_edits row;
 *   - StudioEdit op=adjust + input_image bytes -> asserts the handler REJECTS it
 *     ("input_image is only valid for deviceRender").
 *
 * This exercises the wire layer studio-e2e bypasses: proto decode of the `bytes`
 * field -> handler guards -> engine.edit. Run: pnpm tsx scripts/studio-wire-check.ts
 */

import "dotenv/config";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import sharp from "sharp";
import { LOCAL_TENANT } from "../src/auth/tenant-context.ts";
import { GrpcServer } from "../src/daemon/grpc-server.ts";
import type { MessageQueue } from "../src/daemon/message-queue.ts";
import { closeDb, getKysely } from "../src/db/client.ts";
import { createAsset } from "../src/studio/assets.ts";
import { getObjectStore, objectKey } from "../src/storage/object-store.ts";

const PORT = 18767;
const log = (...a: unknown[]) => console.log(...a);

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = existsSync(resolve(__dirname, "../proto/nomos.proto"))
  ? resolve(__dirname, "../proto/nomos.proto")
  : resolve(__dirname, "../../proto/nomos.proto");

interface EditEvent {
  kind: string;
  editId: string;
  status: string;
  outputKey: string;
  message: string;
}

function makeClient(): {
  StudioEdit: (req: unknown) => grpc.ClientReadableStream<EditEvent>;
  close: () => void;
} {
  const def = protoLoader.loadSync(PROTO_PATH, {
    keepCase: false,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const pkg = grpc.loadPackageDefinition(def).nomos as {
    MobileApi: new (addr: string, creds: grpc.ChannelCredentials) => Record<string, unknown>;
  };
  const client = new pkg.MobileApi(`127.0.0.1:${PORT}`, grpc.credentials.createInsecure());
  return {
    StudioEdit: (req) =>
      (client.StudioEdit as (r: unknown) => grpc.ClientReadableStream<EditEvent>)(req),
    close: () => (client as { close: () => void }).close(),
  };
}

function runEdit(
  client: ReturnType<typeof makeClient>,
  req: Record<string, unknown>,
): Promise<EditEvent[]> {
  return new Promise((resolveP, rejectP) => {
    const events: EditEvent[] = [];
    const stream = client.StudioEdit(req);
    stream.on("data", (ev: EditEvent) => events.push(ev));
    stream.on("end", () => resolveP(events));
    stream.on("error", (err) => rejectP(err));
  });
}

async function main(): Promise<void> {
  const store = getObjectStore();
  const server = new GrpcServer({} as MessageQueue, PORT);
  await server.start();
  const client = makeClient();
  const ctx = LOCAL_TENANT;

  // Seed an asset under the tenant the wire resolves to (power-user -> LOCAL_TENANT).
  const original = await sharp({
    create: { width: 640, height: 480, channels: 3, background: { r: 120, g: 90, b: 70 } },
  })
    .jpeg()
    .toBuffer();
  const key = objectKey("studio", randomUUID(), "original.jpg");
  await store.put(key, new Uint8Array(original), "image/jpeg");
  const asset = await createAsset(ctx, {
    objectKey: key,
    contentHash: "wire",
    mime: "image/jpeg",
    width: 640,
    height: 480,
    bytes: original.byteLength,
  });
  log(`asset ${asset.id}`);

  // The "on-device render": a tinted variant the client uploads inline.
  const rendered = await sharp(original).modulate({ saturation: 1.4 }).jpeg().toBuffer();

  // 1) deviceRender over the wire -> done + stored output.
  const ok = await runEdit(client, {
    assetId: asset.id,
    op: "deviceRender",
    paramsJson: JSON.stringify({ tool: "makeup", detail: "lips" }),
    idempotencyKey: randomUUID(),
    inputImage: rendered,
  });
  const done = ok.find((e) => e.kind === "done");
  const err1 = ok.find((e) => e.kind === "error");
  if (err1) throw new Error(`deviceRender wire error: ${err1.message}`);
  if (!done?.outputKey) throw new Error("deviceRender produced no output over the wire");
  const outBytes = await store.get(done.outputKey);
  const meta = await sharp(Buffer.from(outBytes)).metadata();
  log(
    `WIRE deviceRender: status=${done.status} out=${outBytes.byteLength}B fmt=${meta.format} ${meta.width}x${meta.height}`,
  );
  if (meta.format !== "jpeg") throw new Error("output is not a jpeg");

  // 2) Guard: input_image with a non-deviceRender op is rejected at the handler.
  const guarded = await runEdit(client, {
    assetId: asset.id,
    op: "adjust",
    paramsJson: JSON.stringify({ exposure: 0.2 }),
    idempotencyKey: randomUUID(),
    inputImage: rendered,
  });
  const guardErr = guarded.find((e) => e.kind === "error");
  if (!guardErr || !/only valid for deviceRender/.test(guardErr.message)) {
    throw new Error(`expected op-guard rejection, got: ${JSON.stringify(guarded)}`);
  }
  log(`WIRE guard: rejected as expected -> "${guardErr.message}"`);

  // Effect SQL: a done deviceRender row exists for this tenant.
  const db = getKysely();
  const rows = await db
    .selectFrom("studio_edits")
    .selectAll()
    .where("user_id", "=", ctx.userId)
    .where("op", "=", "deviceRender")
    .where("status", "=", "done")
    .execute();
  log(`EFFECT deviceRender done rows=${rows.length}`);
  if (rows.length < 1) throw new Error("no done deviceRender row persisted");

  // cleanup
  await db.deleteFrom("studio_edits").where("user_id", "=", ctx.userId).execute();
  await db.deleteFrom("studio_assets").where("user_id", "=", ctx.userId).execute();
  client.close();
  await server.stop();
  await closeDb();
  log("WIRE OK; cleaned up");
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
