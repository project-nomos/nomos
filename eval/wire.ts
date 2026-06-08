/**
 * Wire harness: boots the REAL MobileApi Connect server in-process and builds
 * Connect clients, so the eval exercises the mobile endpoints over the actual
 * wire (request decode -> auth -> handler -> response encode), not the functions.
 *
 * In power-user mode the interceptor resolves LOCAL_TENANT with no token. In
 * hosted mode (see startHostedAuth) the server enforces a Bearer JWT, so a client
 * built with a token getter authenticates as a specific tenant; one built without
 * a token is rejected at the wire.
 */

import { createClient, type Client, type Interceptor } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { ConnectServer } from "../src/daemon/connect-server.ts";
import { MobileApi } from "../src/gen/nomos_pb.ts";
import type { MessageQueue } from "../src/daemon/message-queue.ts";

export interface ServerHandle {
  port: number;
  stop: () => Promise<void>;
}

/** Boot the MobileApi Connect server on a test port. */
export async function startConnectServer(port = 8799): Promise<ServerHandle> {
  // The vault/session RPCs under test do not touch the queue; Chat (the only
  // queue consumer) is exercised separately via the gRPC agent path.
  const server = new ConnectServer({
    messageQueue: {} as MessageQueue,
    draftManager: null,
    port,
  });
  await server.start();
  return { port, stop: () => server.stop() };
}

/**
 * A MobileApi client for the given port. With a token getter, every RPC (incl.
 * the streaming Chat) carries `authorization: Bearer <jwt>`; without one, no auth
 * header is sent.
 */
export function makeMobileClient(port: number, getToken?: () => string): Client<typeof MobileApi> {
  const interceptors: Interceptor[] = [];
  if (getToken) {
    interceptors.push((next) => async (req) => {
      req.header.set("authorization", `Bearer ${getToken()}`);
      return next(req);
    });
  }
  const transport = createConnectTransport({
    baseUrl: `http://127.0.0.1:${port}`,
    httpVersion: "1.1",
    interceptors,
  });
  return createClient(MobileApi, transport);
}

export interface WireHandle {
  client: Client<typeof MobileApi>;
  stop: () => Promise<void>;
}

/** Convenience for the power-user wire test: server + one unauthenticated client. */
export async function startWire(port = 8799): Promise<WireHandle> {
  const server = await startConnectServer(port);
  return { client: makeMobileClient(port), stop: server.stop };
}
