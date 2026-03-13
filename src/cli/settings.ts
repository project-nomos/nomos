/**
 * CLI command for launching the Settings web UI.
 *
 * Usage:
 *   nomos settings           — Start settings UI on http://localhost:3456
 *   nomos settings --port N  — Use custom port
 *   nomos settings --dev     — Run in dev mode (hot reload)
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";

function getSettingsDir(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, "settings");
    if (
      fs.existsSync(candidate) &&
      fs.existsSync(path.join(candidate, "package.json"))
    ) {
      return candidate;
    }
    dir = path.dirname(dir);
  }
  throw new Error(
    "Could not find settings/ directory. Ensure it exists in the project root.",
  );
}

export function registerSettingsCommand(program: Command): void {
  program
    .command("settings")
    .description("Open the settings web UI in your browser")
    .option("-p, --port <port>", "Port number", "3456")
    .option("-d, --dev", "Run in dev mode with hot reload")
    .action(async (options) => {
      const chalk = (await import("chalk")).default;
      const { spawn, spawnSync, exec } = await import("node:child_process");

      const settingsDir = getSettingsDir();
      const port = options.port;
      const devMode = options.dev ?? false;

      // Ensure dependencies are installed
      const nodeModules = path.join(settingsDir, "node_modules");
      if (!fs.existsSync(nodeModules)) {
        console.log(chalk.dim("Installing settings UI dependencies..."));
        const result = spawnSync("pnpm", ["install"], {
          cwd: settingsDir,
          stdio: "inherit",
        });

        if (result.status !== 0) {
          console.error(
            chalk.red("Failed to install dependencies. Run manually:"),
          );
          console.error(chalk.dim(`  cd ${settingsDir} && pnpm install`));
          process.exit(1);
        }
      }

      // Build if not in dev mode
      if (!devMode) {
        const buildIdFile = path.join(settingsDir, ".next", "BUILD_ID");
        if (!fs.existsSync(buildIdFile)) {
          console.log(chalk.dim("Building settings UI..."));
          const result = spawnSync("npx", ["next", "build"], {
            cwd: settingsDir,
            stdio: "inherit",
          });

          if (result.status !== 0) {
            console.error(chalk.red("Build failed. Try --dev mode instead."));
            process.exit(1);
          }
        }
      }

      const url = `http://localhost:${port}`;
      console.log(
        chalk.hex("#CBA6F7").bold("\nStarting Nomos Settings UI...\n"),
      );
      console.log(chalk.dim(`  ${url}\n`));

      // Start Next.js in production or dev mode
      const nextArgs = devMode
        ? ["next", "dev", "--port", port]
        : ["next", "start", "--port", port];
      const next = spawn("npx", nextArgs, {
        cwd: settingsDir,
        stdio: "inherit",
        env: { ...process.env },
      });

      // Open browser after a short delay
      setTimeout(() => {
        const cmd =
          process.platform === "darwin"
            ? "open"
            : process.platform === "win32"
              ? "start"
              : "xdg-open";
        exec(`${cmd} "${url}"`, () => {
          // Silently ignore errors — user can open manually
        });
      }, devMode ? 2000 : 500);

      // Handle shutdown
      const cleanup = () => {
        next.kill("SIGTERM");
        process.exit(0);
      };

      process.on("SIGINT", cleanup);
      process.on("SIGTERM", cleanup);

      // Keep alive
      await new Promise<void>((resolve) => {
        next.on("close", () => resolve());
      });
    });
}
