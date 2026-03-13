/**
 * Daemon lifecycle management: PID file, signal handlers, graceful shutdown.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const PID_DIR = path.join(os.homedir(), ".nomos");
const PID_FILE = path.join(PID_DIR, "daemon.pid");
const LOG_FILE = path.join(PID_DIR, "daemon.log");

export function getPidFilePath(): string {
  return PID_FILE;
}

export function getLogFilePath(): string {
  return LOG_FILE;
}

/** Write PID file for the current process. */
export function writePidFile(): void {
  fs.mkdirSync(PID_DIR, { recursive: true });
  fs.writeFileSync(PID_FILE, String(process.pid), "utf-8");
}

/** Remove PID file. */
export function removePidFile(): void {
  try {
    fs.unlinkSync(PID_FILE);
  } catch {
    // Already removed
  }
}

/** Read PID from file. Returns null if not found. */
export function readPidFile(): number | null {
  try {
    const content = fs.readFileSync(PID_FILE, "utf-8").trim();
    const pid = parseInt(content, 10);
    return Number.isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

/** Check if a process with the given PID is running. */
export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Check if the daemon is currently running. */
export function isDaemonRunning(): { running: boolean; pid: number | null } {
  const pid = readPidFile();
  if (pid === null) return { running: false, pid: null };

  const running = isProcessRunning(pid);
  if (!running) {
    // Stale PID file — clean up
    removePidFile();
    return { running: false, pid: null };
  }

  return { running: true, pid };
}

/**
 * Install signal handlers for graceful shutdown.
 * Calls `onShutdown` when SIGTERM, SIGINT, or SIGHUP are received.
 */
export function installSignalHandlers(onShutdown: () => Promise<void>): void {
  let shuttingDown = false;

  const handler = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;

    console.log(`[daemon] Received ${signal}, shutting down...`);
    try {
      await onShutdown();
    } catch (err) {
      console.error("[daemon] Error during shutdown:", err);
    }
    removePidFile();
    process.exit(0);
  };

  process.on("SIGTERM", () => handler("SIGTERM"));
  process.on("SIGINT", () => handler("SIGINT"));
  process.on("SIGHUP", () => handler("SIGHUP"));

  // Handle uncaught errors
  process.on("uncaughtException", (err) => {
    console.error("[daemon] Uncaught exception:", err);
    removePidFile();
    process.exit(1);
  });

  process.on("unhandledRejection", (reason) => {
    console.error("[daemon] Unhandled rejection:", reason);
  });
}
