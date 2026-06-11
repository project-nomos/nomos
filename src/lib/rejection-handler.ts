import process from "node:process";
import { createLogger } from "./logger.ts";

const log = createLogger("nomos");

/**
 * Known harmless SDK cleanup race: the Claude Agent SDK's ProcessTransport can
 * close before a pending MCP control request settles. The session is already
 * done, so the rejection is noise -- suppress it.
 */
export function isIgnorableRejection(reason: unknown): boolean {
  return reason instanceof Error && reason.message.includes("ProcessTransport is not ready");
}

/**
 * Global unhandled-rejection handler.
 *
 * A long-running daemon MUST survive background promise rejections from flaky
 * external integrations -- a revoked Slack token, a dropped Discord socket, an
 * expired Telegram session. This handler used to call `process.exit(1)` on
 * every unhandled rejection; combined with launchd `KeepAlive=true` that turned
 * a single revoked Slack token into an infinite crash-restart loop (the daemon
 * booted, a background Slack `auth.test` rejected with `invalid_auth`, the
 * process exited, launchd restarted it, forever -- writing a 227 MB log).
 *
 * Log loudly so the failure is visible, but never exit. A genuinely fatal,
 * synchronous error still goes through the `uncaughtException` handler.
 */
export function handleUnhandledRejection(reason: unknown): void {
  if (isIgnorableRejection(reason)) return;
  log.error({ err: reason }, "Unhandled rejection");
}

/** Install the global unhandled-rejection handler. Call once at startup. */
export function installRejectionHandler(): void {
  process.on("unhandledRejection", handleUnhandledRejection);
}
