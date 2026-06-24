/**
 * Device bridge — lets the daemon-resident agent act on a connected phone's native
 * EventKit (Calendar + Reminders). The agent runs in the daemon, not on the phone, so
 * the direction is inverted: the phone is a gRPC client that opens the `DeviceBridge`
 * server-stream on launch; the daemon pushes tool *invocations* down that stream and
 * the phone returns each *result* via the unary `SubmitDeviceResult`.
 *
 * This registry is the rendezvous: it maps a tenant `userId` to the connected phone's
 * invocation sink + a pending-results map, correlated by a per-invocation id. The
 * `native-device` MCP tools call `invoke()` and await the matching result (or a
 * timeout / disconnect). No device connected → the tool fails cleanly, so the agent
 * can tell the user to open the app.
 */

import { randomUUID } from "node:crypto";
import { createLogger } from "../lib/logger.ts";

const log = createLogger("device-bridge");

export interface DeviceInvocation {
  id: string;
  tool: string;
  argsJson: string;
}

export interface DeviceResult {
  ok: boolean;
  resultJson?: string;
  error?: string;
}

/** How long the agent waits for the phone to run one EventKit call before giving up. */
const INVOKE_TIMEOUT_MS = 30_000;

interface Conn {
  capabilities: Set<string>;
  send: (inv: DeviceInvocation) => void;
  pending: Map<
    string,
    { resolve: (r: DeviceResult) => void; timer: ReturnType<typeof setTimeout> }
  >;
}

export class DeviceBridgeRegistry {
  private conns = new Map<string, Conn>();

  /**
   * Register a freshly-opened DeviceBridge stream for `userId`. A new connection
   * supersedes any older one for the same user (latest device wins). Returns an
   * unregister fn to call when the stream ends.
   */
  register(
    userId: string,
    capabilities: string[],
    send: (inv: DeviceInvocation) => void,
  ): () => void {
    this.unregister(userId);
    const conn: Conn = { capabilities: new Set(capabilities), send, pending: new Map() };
    this.conns.set(userId, conn);
    log.info({ userId, capabilities }, "device connected");
    return () => this.unregister(userId, conn);
  }

  private unregister(userId: string, only?: Conn): void {
    const conn = this.conns.get(userId);
    if (!conn || (only && conn !== only)) return;
    for (const p of conn.pending.values()) {
      clearTimeout(p.timer);
      p.resolve({ ok: false, error: "device disconnected" });
    }
    conn.pending.clear();
    this.conns.delete(userId);
    log.info({ userId }, "device disconnected");
  }

  isConnected(userId: string): boolean {
    return this.conns.has(userId);
  }

  /** The native capabilities the connected device offered (empty if none connected). */
  capabilities(userId: string): string[] {
    return [...(this.conns.get(userId)?.capabilities ?? [])];
  }

  /**
   * Push one tool invocation to the user's connected phone and await its result.
   * Resolves (never rejects) with `{ ok: false, error }` when no device is connected,
   * the send fails, or the phone does not answer in time.
   */
  async invoke(userId: string, tool: string, argsJson: string): Promise<DeviceResult> {
    const conn = this.conns.get(userId);
    if (!conn) {
      return {
        ok: false,
        error:
          "No device connected. Open the Nomos app on your phone to use native Calendar/Reminders.",
      };
    }
    const id = randomUUID();
    return new Promise<DeviceResult>((resolve) => {
      const timer = setTimeout(() => {
        conn.pending.delete(id);
        resolve({
          ok: false,
          error: `Device did not respond within ${INVOKE_TIMEOUT_MS / 1000}s.`,
        });
      }, INVOKE_TIMEOUT_MS);
      conn.pending.set(id, { resolve, timer });
      try {
        conn.send({ id, tool, argsJson });
      } catch (e) {
        clearTimeout(timer);
        conn.pending.delete(id);
        resolve({ ok: false, error: `Failed to reach device: ${(e as Error).message}` });
      }
    });
  }

  /** Resolve a pending invocation with the phone's result (from SubmitDeviceResult). */
  resolveResult(userId: string, id: string, result: DeviceResult): void {
    const conn = this.conns.get(userId);
    const p = conn?.pending.get(id);
    if (!p) {
      log.warn({ userId, id }, "result for unknown or expired invocation");
      return;
    }
    clearTimeout(p.timer);
    conn!.pending.delete(id);
    p.resolve(result);
  }
}

let singleton: DeviceBridgeRegistry | undefined;
export function getDeviceBridge(): DeviceBridgeRegistry {
  return (singleton ??= new DeviceBridgeRegistry());
}
