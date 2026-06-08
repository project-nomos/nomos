/**
 * Wire harness: boots the REAL MobileApi Connect server in-process and returns a
 * Connect client, so the eval exercises the mobile endpoints over the actual wire
 * (request decode -> auth -> handler -> response encode), not just the functions.
 *
 * Runs in power-user mode, where the gRPC interceptor resolves LOCAL_TENANT with
 * no token (hosted wire would additionally need a minted EdDSA JWT + a served
 * JWKS; the per-tenant handler behavior is covered at the resolution layer).
 */

import { createClient, type Client } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { ConnectServer } from "../src/daemon/connect-server.ts";
import { MobileApi } from "../src/gen/nomos_pb.ts";
import type { MessageQueue } from "../src/daemon/message-queue.ts";

export interface WireHandle {
  client: Client<typeof MobileApi>;
  stop: () => Promise<void>;
}

/** Boot the MobileApi Connect server on a test port and return a client. */
export async function startWire(port = 8799): Promise<WireHandle> {
  // The vault/session RPCs under test do not touch the queue; Chat (the only
  // queue consumer) is exercised separately via the agent path.
  const server = new ConnectServer({
    messageQueue: {} as MessageQueue,
    draftManager: null,
    port,
  });
  await server.start();

  const transport = createConnectTransport({
    baseUrl: `http://127.0.0.1:${port}`,
    httpVersion: "1.1",
  });
  const client = createClient(MobileApi, transport);

  return { client, stop: () => server.stop() };
}
