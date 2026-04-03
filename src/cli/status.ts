/**
 * CLI command: nomos status
 *
 * Shows the status of all nomos processes at a glance:
 * daemon, settings UI, launchd service, and database.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import type { Command } from "commander";
import { isDaemonRunning, getLogFilePath, getPidFilePath } from "../daemon/lifecycle.ts";

const PLIST_LABEL = "com.projectnomos.daemon";
const PLIST_PATH = path.join(os.homedir(), "Library", "LaunchAgents", `${PLIST_LABEL}.plist`);

function isServiceLoaded(): boolean {
  try {
    const output = execSync(`launchctl list ${PLIST_LABEL} 2>/dev/null`, {
      encoding: "utf-8",
    });
    return output.includes(PLIST_LABEL);
  } catch {
    return false;
  }
}

function getServicePid(): number | null {
  try {
    const output = execSync(`launchctl list ${PLIST_LABEL} 2>/dev/null`, {
      encoding: "utf-8",
    });
    const pidMatch = output.match(/"PID"\s*=\s*(\d+)/);
    if (pidMatch) return parseInt(pidMatch[1], 10);
    const firstLine = output.trim().split("\n")[0];
    if (firstLine) {
      const pid = parseInt(firstLine.split("\t")[0], 10);
      if (!Number.isNaN(pid)) return pid;
    }
    return null;
  } catch {
    return null;
  }
}

async function isPortListening(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${port}`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok || res.status < 500;
  } catch {
    return false;
  }
}

async function isDatabaseReachable(): Promise<boolean> {
  try {
    const { getDb } = await import("../db/client.ts");
    const sql = getDb();
    await sql`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

export function registerStatusCommand(program: Command): void {
  program
    .command("status")
    .description("Show status of all nomos processes")
    .action(async () => {
      const chalk = (await import("chalk")).default;

      const ok = chalk.green("●");
      const off = chalk.dim("○");
      const warn = chalk.yellow("●");

      console.log(chalk.bold("\nNomos Status\n"));

      // 1. Daemon
      const { running: daemonRunning, pid: daemonPid } = isDaemonRunning();
      if (daemonRunning) {
        console.log(`  ${ok} Daemon         PID ${daemonPid}`);
      } else {
        console.log(`  ${off} Daemon         not running`);
      }

      // 2. gRPC
      const grpcPort = Number(process.env.DAEMON_GRPC_PORT ?? "8766");
      let grpcUp = false;
      if (daemonRunning) {
        try {
          const net = await import("node:net");
          grpcUp = await new Promise<boolean>((resolve) => {
            const sock = net.createConnection({ port: grpcPort, timeout: 1000 });
            sock.on("connect", () => {
              sock.destroy();
              resolve(true);
            });
            sock.on("error", () => resolve(false));
            sock.on("timeout", () => {
              sock.destroy();
              resolve(false);
            });
          });
        } catch {
          grpcUp = false;
        }
      }
      if (grpcUp) {
        console.log(`  ${ok} gRPC           localhost:${grpcPort}`);
      } else {
        console.log(`  ${off} gRPC           localhost:${grpcPort}`);
      }

      // 3. Settings UI
      const settingsPort = Number(process.env.SETTINGS_PORT ?? "3456");
      const settingsUp = await isPortListening(settingsPort);
      if (settingsUp) {
        console.log(`  ${ok} Settings UI    http://localhost:${settingsPort}`);
      } else {
        console.log(`  ${off} Settings UI    http://localhost:${settingsPort}`);
      }

      // 4. Database
      const dbUp = await isDatabaseReachable();
      if (dbUp) {
        console.log(`  ${ok} Database       connected`);
      } else {
        console.log(`  ${warn} Database       not reachable`);
      }

      // 5. Launchd service (macOS only)
      if (process.platform === "darwin") {
        const installed = fs.existsSync(PLIST_PATH);
        const loaded = installed && isServiceLoaded();
        const servicePid = loaded ? getServicePid() : null;
        if (loaded && servicePid) {
          console.log(`  ${ok} Service        launchd (PID ${servicePid})`);
        } else if (installed) {
          console.log(`  ${warn} Service        installed but not loaded`);
        } else {
          console.log(
            `  ${off} Service        not installed  ${chalk.dim("(nomos service install)")}`,
          );
        }
      }

      // 6. Logs
      const logFile = getLogFilePath();
      if (fs.existsSync(logFile)) {
        const stat = fs.statSync(logFile);
        const age = Date.now() - stat.mtimeMs;
        const ageStr =
          age < 60_000
            ? "just now"
            : age < 3_600_000
              ? `${Math.floor(age / 60_000)}m ago`
              : `${Math.floor(age / 3_600_000)}h ago`;
        console.log(
          `  ${chalk.dim("◦")} Logs           ${chalk.dim(logFile)}  ${chalk.dim(`(last write: ${ageStr})`)}`,
        );
      }

      console.log();
    });
}
