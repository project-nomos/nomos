/**
 * CLI commands for managing the nomos launchd service (macOS).
 *
 * Usage:
 *   nomos service install    — Install and start the launchd service
 *   nomos service uninstall  — Stop and remove the launchd service
 *   nomos service status     — Show service registration status
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import type { Command } from "commander";

const PLIST_LABEL = "com.projectnomos.daemon";
const PLIST_DIR = path.join(os.homedir(), "Library", "LaunchAgents");
const PLIST_PATH = path.join(PLIST_DIR, `${PLIST_LABEL}.plist`);

function getNomosPath(): string {
  // Find the nomos binary — prefer the one that's currently running
  const scriptPath = process.argv[1]!;

  // If running from a built binary (Homebrew), resolve the wrapper's target
  try {
    const content = fs.readFileSync(scriptPath, "utf-8");
    // Homebrew wrapper scripts contain the actual path
    const match = content.match(/exec\s+"?([^"\s]+index\.js)"?/);
    if (match) return match[1];
  } catch {
    // Not a wrapper script
  }

  // Try to find nomos in PATH
  try {
    const which = execSync("which nomos", { encoding: "utf-8" }).trim();
    if (which) return which;
  } catch {
    // Not in PATH
  }

  return scriptPath;
}

function generatePlist(nomosPath: string): string {
  const logDir = path.join(os.homedir(), ".nomos", "logs");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_LABEL}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${nomosPath}</string>
    <string>daemon</string>
    <string>run</string>
  </array>

  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${os.homedir()}</string>
    <key>PATH</key>
    <string>/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>DAEMON_WITH_SETTINGS</key>
    <string>true</string>
    <key>SETTINGS_PORT</key>
    <string>3456</string>
  </dict>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <key>StandardOutPath</key>
  <string>${logDir}/daemon.log</string>

  <key>StandardErrorPath</key>
  <string>${logDir}/daemon.log</string>

  <key>WorkingDirectory</key>
  <string>${os.homedir()}</string>

  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>`;
}

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
    // Output format: "PID\tStatus\tLabel" or "{\n\t"PID" = ...\n..."
    const pidMatch = output.match(/"PID"\s*=\s*(\d+)/);
    if (pidMatch) return parseInt(pidMatch[1], 10);
    // Simple format: first column is PID (or "-" if not running)
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

export function registerServiceCommand(program: Command): void {
  const service = program
    .command("service")
    .description("Manage the nomos background service (macOS launchd)");

  service
    .command("install")
    .description("Install and start the launchd service")
    .action(async () => {
      if (process.platform !== "darwin") {
        console.error("Service management is only supported on macOS");
        process.exit(1);
      }

      const chalk = (await import("chalk")).default;
      const { isDaemonRunning, isProcessRunning, removePidFile } =
        await import("../daemon/lifecycle.ts");
      const nomosPath = getNomosPath();

      // Create log directory
      const logDir = path.join(os.homedir(), ".nomos", "logs");
      fs.mkdirSync(logDir, { recursive: true });

      // Stop any manually-started daemon (PID-based) so ports are free for launchd
      const { running, pid } = isDaemonRunning();
      if (running && pid) {
        console.log(chalk.dim(`Stopping existing daemon (PID ${pid})...`));
        try {
          process.kill(pid, "SIGTERM");
          // Wait up to 5s for graceful shutdown
          const start = Date.now();
          while (Date.now() - start < 5000 && isProcessRunning(pid)) {
            await new Promise((r) => setTimeout(r, 200));
          }
          if (isProcessRunning(pid)) {
            process.kill(pid, "SIGKILL");
          }
        } catch {
          // Process may have already exited
        }
        removePidFile();
      }

      // Unload existing service if present
      if (isServiceLoaded()) {
        try {
          execSync(`launchctl bootout gui/${process.getuid!()} ${PLIST_PATH} 2>/dev/null`);
        } catch {
          // May not be loaded
        }
      }

      // Write plist
      try {
        fs.mkdirSync(PLIST_DIR, { recursive: true });
        fs.writeFileSync(PLIST_PATH, generatePlist(nomosPath), "utf-8");
      } catch (err) {
        // Homebrew post_install sandbox blocks writes to ~/Library/LaunchAgents
        if ((err as NodeJS.ErrnoException).code === "EPERM") {
          console.warn(
            chalk.yellow("⚠ Cannot write plist (sandbox restriction). Run manually after install:"),
          );
          console.warn(chalk.dim("  nomos service install"));
          return;
        }
        throw err;
      }

      // Load and start
      try {
        execSync(`launchctl bootstrap gui/${process.getuid!()} ${PLIST_PATH}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Failed to start service: ${msg}`));
        process.exit(1);
      }

      console.log(chalk.green("✓ Service installed and started"));
      console.log(chalk.dim(`  Plist:    ${PLIST_PATH}`));
      console.log(chalk.dim(`  Logs:     ${path.join(logDir, "daemon.log")}`));
      console.log(chalk.dim(`  Daemon:   localhost:8765 (WS) / localhost:8766 (gRPC)`));
      console.log(chalk.dim(`  Settings: http://localhost:3456`));
      console.log();
      console.log(chalk.dim("The service will start automatically on login."));
      console.log(chalk.dim("To stop: nomos service uninstall"));
    });

  service
    .command("uninstall")
    .description("Stop and remove the launchd service")
    .action(async () => {
      if (process.platform !== "darwin") {
        console.error("Service management is only supported on macOS");
        process.exit(1);
      }

      const chalk = (await import("chalk")).default;

      if (!fs.existsSync(PLIST_PATH)) {
        console.log("Service is not installed");
        return;
      }

      // Unload
      if (isServiceLoaded()) {
        try {
          execSync(`launchctl bootout gui/${process.getuid!()} ${PLIST_PATH}`);
        } catch {
          // Best effort
        }
      }

      // Remove plist
      fs.unlinkSync(PLIST_PATH);

      console.log(chalk.green("✓ Service uninstalled"));
    });

  service
    .command("status")
    .description("Show service status")
    .action(async () => {
      const chalk = (await import("chalk")).default;

      if (process.platform !== "darwin") {
        console.error("Service management is only supported on macOS");
        process.exit(1);
      }

      const installed = fs.existsSync(PLIST_PATH);
      const loaded = isServiceLoaded();
      const pid = loaded ? getServicePid() : null;

      console.log(chalk.bold("Nomos Service"));
      console.log(
        `  Plist:    ${installed ? chalk.green("installed") : chalk.dim("not installed")}  ${chalk.dim(PLIST_PATH)}`,
      );
      console.log(`  Service:  ${loaded ? chalk.green("loaded") : chalk.dim("not loaded")}`);
      if (pid) {
        console.log(`  PID:      ${chalk.green(String(pid))}`);
      }
    });
}
