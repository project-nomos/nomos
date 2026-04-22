/**
 * Auto-start the daemon when `nomos` is run without a subcommand.
 *
 * Checks if the daemon is already running. If not, spawns it in the background
 * and waits for it to become reachable before returning.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import chalk from "chalk";
import { isDaemonRunning, getLogFilePath } from "../daemon/lifecycle.ts";
import { GrpcClient } from "../ui/grpc-client.ts";

/**
 * Start the daemon in the background if it's not already running.
 * Waits until the daemon is reachable via gRPC before returning.
 */
export async function startDaemonIfNeeded(): Promise<void> {
  const { running } = isDaemonRunning();
  if (running) return;

  const port = process.env.DAEMON_PORT ?? "8765";
  const logFile = getLogFilePath();
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const logFd = fs.openSync(logFile, "a");

  // Re-invoke the same CLI binary with "daemon run"
  const scriptPath = process.argv[1]!;
  const tsArgs = scriptPath.endsWith(".ts") ? ["--import", "tsx"] : [];
  const child = spawn(process.execPath, [...tsArgs, scriptPath, "daemon", "run", "-p", port], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env },
  });
  child.unref();
  fs.closeSync(logFd);

  console.log(chalk.dim(`Starting daemon (PID ${child.pid})...`));

  // Wait for daemon to become reachable via gRPC
  const grpcPort = Number(port) + 1;
  const client = new GrpcClient({ port: grpcPort });

  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    await new Promise((r) => setTimeout(r, 500));
    ready = await client.isDaemonReachable();
    if (ready) break;
  }

  if (ready) {
    console.log(chalk.dim(`Daemon running (PID ${child.pid}, gRPC :${grpcPort})`));
  } else {
    console.log(chalk.yellow(`Daemon may not have started in time. Check logs: ${logFile}`));
  }
}
