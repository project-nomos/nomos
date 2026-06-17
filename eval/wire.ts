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

import { createServer as createNetServer } from "node:net";
import type { AddressInfo } from "node:net";
import { createClient, type Client, type Interceptor } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { ConnectServer } from "../src/daemon/connect-server.ts";
import { MobileApi } from "../src/gen/nomos_pb.ts";
import type { MessageQueue } from "../src/daemon/message-queue.ts";

export interface ServerHandle {
  port: number;
  stop: () => Promise<void>;
}

/**
 * Ask the OS for a free ephemeral port. The harness used to hardcode ports
 * (8797-8799), which collide with whatever the dev box happens to be running
 * (e.g. the studio sidecar binds 8799) — the client then reaches the wrong
 * server and the RPC fails UNIMPLEMENTED. Binding :0 and reading back the
 * assigned port sidesteps the collision entirely.
 */
async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const port = (probe.address() as AddressInfo).port;
      probe.close(() => resolve(port));
    });
  });
}

/**
 * Boot the MobileApi Connect server on a test port. Pass a real `messageQueue`
 * to exercise the streaming Chat RPC; the vault/session RPCs do not touch it, so
 * the unary tests can leave it as a stub. Omit `port` (or pass 0) to bind a free
 * ephemeral port — read the chosen port back off the returned handle.
 */
export async function startConnectServer(
  port?: number,
  messageQueue?: MessageQueue,
): Promise<ServerHandle> {
  const actualPort = port && port > 0 ? port : await findFreePort();
  const server = new ConnectServer({
    messageQueue: messageQueue ?? ({} as MessageQueue),
    draftManager: null,
    port: actualPort,
  });
  await server.start();
  return { port: actualPort, stop: () => server.stop() };
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
export async function startWire(port?: number): Promise<WireHandle> {
  const server = await startConnectServer(port);
  return { client: makeMobileClient(server.port), stop: server.stop };
}
