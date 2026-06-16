/**
 * Real HTTP e2e for the local-fs blob serving (the iOS upload path).
 * presign PUT -> real HTTP PUT -> daemon serves it -> presign GET -> real HTTP GET.
 * Mirrors the Connect server's wrapper. No DB needed.
 *
 * Run:  pnpm tsx scripts/studio-blob-e2e.ts
 */

import "dotenv/config";
import { createServer } from "node:http";
import {
  getObjectStore,
  handleBlobRequest,
  objectKey,
  resetObjectStoreForTest,
} from "../src/storage/object-store.ts";

async function main(): Promise<void> {
  const port = 8788;
  process.env.NOMOS_OBJECT_STORE_DRIVER = "local";
  process.env.NOMOS_OBJECT_STORE_PUBLIC_URL = `http://localhost:${port}`;
  resetObjectStoreForTest();
  const store = getObjectStore();

  // Exactly the Connect server's wrapper: blob route first, else 404.
  const server = createServer((req, res) => {
    void handleBlobRequest(req, res).then((handled) => {
      if (!handled) res.writeHead(404).end("not a blob route");
    });
  });
  await new Promise<void>((r) => server.listen(port, () => r()));

  const key = objectKey("studio", "e2e-blob", "original.jpg");
  const bytes = Buffer.from("hello studio blob upload", "utf8");
  let ok = true;

  // 1) presign + real HTTP PUT (the iOS upload)
  const put = await store.presignPut(key, { contentType: "image/jpeg" });
  console.log("PUT url:", put.url);
  const putResp = await fetch(put.url, {
    method: "PUT",
    body: bytes,
    headers: { "content-type": "image/jpeg" },
  });
  console.log(`PUT -> ${putResp.status}`);
  if (putResp.status !== 200) ok = false;

  // 2) the bytes actually landed in the store
  const stored = Buffer.from(await store.get(key));
  console.log(`stored=${stored.length}B match=${stored.equals(bytes)}`);
  if (!stored.equals(bytes)) ok = false;

  // 3) presign + real HTTP GET (refreshImage)
  const get = await store.presignGet(key);
  const getResp = await fetch(get.url);
  const got = Buffer.from(await getResp.arrayBuffer());
  console.log(
    `GET -> ${getResp.status} ${got.length}B match=${got.equals(bytes)} ct=${getResp.headers.get("content-type")}`,
  );
  if (getResp.status !== 200 || !got.equals(bytes)) ok = false;

  // 4) a tampered signature must be rejected
  const bad = put.url.replace(/sig=[a-f0-9]+/, "sig=deadbeef");
  const badResp = await fetch(bad, { method: "PUT", body: bytes });
  console.log(`tampered PUT -> ${badResp.status} (expect 403)`);
  if (badResp.status !== 403) ok = false;

  await store.delete(key);
  server.close();
  console.log(ok ? "\nBLOB E2E: PASS" : "\nBLOB E2E: FAIL");
  if (!ok) process.exit(1);
}

main().catch((err) => {
  console.error("BLOB E2E: FAIL", err);
  process.exit(1);
});
