/**
 * CLI commands for daemon lifecycle management.
 *
 * Usage:
 *   nomos daemon start    — Start daemon in background
 *   nomos daemon stop     — Stop running daemon
 *   nomos daemon restart  — Restart daemon
 *   nomos daemon status   — Show daemon status
 *   nomos daemon logs     — Tail daemon logs
 *   nomos daemon run      — Run daemon in foreground (for development)
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import type { Command } from "commander";
import path from "node:path";
import {
  isDaemonRunning,
  isProcessRunning,
  removePidFile,
  getLogFilePath,
  getPidFilePath,
} from "../daemon/lifecycle.ts";

/**
 * Build the spawn arguments for the daemon child process.
 * When running from source (.ts), we need tsx as the loader.
 * When running from a built bundle (.js/.mjs), plain node works.
 */
function buildSpawnArgs(scriptPath: string, extraArgs: string[]): { cmd: string; args: string[] } {
  const isTsFile = scriptPath.endsWith(".ts") || scriptPath.endsWith(".tsx");

  if (isTsFile) {
    // We're running from source — need tsx.
    // Try to find tsx in node_modules/.bin or use npx as fallback.
    const tsxBin = path.resolve("node_modules", ".bin", "tsx");
    if (fs.existsSync(tsxBin)) {
      return { cmd: tsxBin, args: [scriptPath, ...extraArgs] };
    }
    // Fallback: use node with --import tsx
    return { cmd: process.execPath, args: ["--import", "tsx", scriptPath, ...extraArgs] };
  }

  // Built bundle — plain node works
  return { cmd: process.execPath, args: [scriptPath, ...extraArgs] };
}

/** Send SIGTERM and wait for the process to exit (up to timeoutMs). */
async function stopDaemonProcess(pid: number, timeoutMs: number = 10_000): Promise<boolean> {
  process.kill(pid, "SIGTERM");

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isProcessRunning(pid)) {
      removePidFile();
      return true;
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  // Still alive after timeout — force kill
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Process may have exited between check and kill
  }
  removePidFile();
  return false;
}

export function registerDaemonCommand(program: Command): void {
  const daemon = program.command("daemon").description("Manage the nomos daemon");

  daemon
    .command("start")
    .description("Start the daemon in background")
    .option("-p, --port <port>", "WebSocket port", "8765")
    .option("--no-settings", "Don't start the Settings UI")
    .option("--settings-port <port>", "Settings UI port", "3456")
    .action(async (options) => {
      const { running, pid } = isDaemonRunning();
      if (running) {
        console.log(`Daemon is already running (PID ${pid})`);
        return;
      }

      const logFile = getLogFilePath();
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      const logFd = fs.openSync(logFile, "a");

      const scriptPath = process.argv[1]!;
      const { cmd, args } = buildSpawnArgs(scriptPath, ["daemon", "run", "-p", options.port]);

      const child = spawn(cmd, args, {
        detached: true,
        stdio: ["ignore", logFd, logFd],
        env: {
          ...process.env,
          DAEMON_WITH_SETTINGS: options.settings === false ? "false" : "true",
          SETTINGS_PORT: options.settingsPort,
        },
      });

      child.unref();
      fs.closeSync(logFd);

      console.log(`Daemon started (PID ${child.pid})`);
      console.log(`  WebSocket: ws://localhost:${options.port}`);
      if (options.settings !== false) {
        console.log(`  Settings:  http://localhost:${options.settingsPort}`);
      }
      console.log(`  Logs: ${logFile}`);
    });

  daemon
    .command("stop")
    .description("Stop the running daemon")
    .action(async () => {
      const { running, pid } = isDaemonRunning();
      if (!running || !pid) {
        console.log("Daemon is not running");
        return;
      }

      console.log(`Stopping daemon (PID ${pid})...`);
      try {
        const graceful = await stopDaemonProcess(pid);
        if (graceful) {
          console.log("Daemon stopped");
        } else {
          console.log("Daemon force-killed (did not exit within 10s)");
        }
      } catch (err) {
        console.error("Failed to stop daemon:", err);
      }
    });

  daemon
    .command("restart")
    .description("Restart the daemon")
    .option("-p, --port <port>", "WebSocket port", "8765")
    .option("--no-settings", "Don't start the Settings UI")
    .option("--settings-port <port>", "Settings UI port", "3456")
    .action(async (options) => {
      const { running, pid } = isDaemonRunning();

      if (running && pid) {
        console.log(`Stopping daemon (PID ${pid})...`);
        try {
          await stopDaemonProcess(pid);
        } catch (err) {
          console.error("Failed to stop daemon:", err);
          return;
        }
        console.log("Daemon stopped");
      }

      // Start fresh
      const logFile = getLogFilePath();
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      const logFd = fs.openSync(logFile, "a");

      const scriptPath = process.argv[1]!;
      const { cmd, args } = buildSpawnArgs(scriptPath, ["daemon", "run", "-p", options.port]);

      const child = spawn(cmd, args, {
        detached: true,
        stdio: ["ignore", logFd, logFd],
        env: {
          ...process.env,
          DAEMON_WITH_SETTINGS: options.settings === false ? "false" : "true",
          SETTINGS_PORT: options.settingsPort,
        },
      });

      child.unref();
      fs.closeSync(logFd);

      console.log(`Daemon started (PID ${child.pid})`);
      console.log(`  WebSocket: ws://localhost:${options.port}`);
      if (options.settings !== false) {
        console.log(`  Settings:  http://localhost:${options.settingsPort}`);
      }
      console.log(`  Logs: ${logFile}`);
    });

  daemon
    .command("status")
    .description("Show daemon status")
    .action(() => {
      const { running, pid } = isDaemonRunning();
      if (running) {
        console.log(`Daemon is running (PID ${pid})`);
        console.log(`  PID file: ${getPidFilePath()}`);
        console.log(`  Log file: ${getLogFilePath()}`);
      } else {
        console.log("Daemon is not running");
      }
    });

  daemon
    .command("logs")
    .description("Tail daemon logs")
    .option("-n, --lines <lines>", "Number of lines to show", "50")
    .action((options) => {
      const logFile = getLogFilePath();
      if (!fs.existsSync(logFile)) {
        console.log("No daemon log file found");
        return;
      }

      // Read last N lines
      const content = fs.readFileSync(logFile, "utf-8");
      const lines = content.split("\n");
      const n = parseInt(options.lines, 10);
      const tail = lines.slice(-n).join("\n");
      console.log(tail);
    });

  daemon
    .command("run")
    .description("Run the daemon in foreground (for development)")
    .option("-p, --port <port>", "WebSocket port", "8765")
    .action(async (options) => {
      const { running, pid } = isDaemonRunning();
      if (running) {
        console.log(`Daemon is already running (PID ${pid}). Stop it first.`);
        return;
      }

      process.env.DAEMON_PORT = options.port;

      // Dynamic import to start the daemon in the current process
      await import("../daemon/index.ts");
    });
}
