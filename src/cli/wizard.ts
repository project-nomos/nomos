import readline from "node:readline";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import chalk from "chalk";
import { FEATURES } from "../config/mode.ts";

const execFileAsync = promisify(execFile);

/**
 * First-run setup wizard. Detects missing .env and launches the web-based
 * setup wizard. Falls back to terminal prompts for DATABASE_URL if the
 * web server cannot be started.
 */
export async function runSetupWizard(): Promise<void> {
  console.log();
  console.log(chalk.bold("Welcome to Nomos"));
  console.log(chalk.dim("Let's get you set up.\n"));

  // Try to launch the web-based wizard
  const settingsDir = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    "../../settings",
  );

  const hasSettingsApp = fs.existsSync(path.join(settingsDir, "package.json"));

  if (hasSettingsApp) {
    const port = 3456;
    const url = `http://localhost:${port}/setup`;

    console.log(chalk.dim("Starting setup wizard..."));

    try {
      // Check if settings dev server is already running
      const isRunning = await checkPort(port);

      if (!isRunning) {
        // Start the settings dev server in the background
        const child = spawn("npx", ["next", "dev", "--port", String(port)], {
          cwd: settingsDir,
          stdio: "ignore",
          detached: true,
        });
        child.unref();

        // Wait for the server to be ready (up to 15 seconds)
        let ready = false;
        for (let i = 0; i < 30; i++) {
          await new Promise((r) => setTimeout(r, 500));
          ready = await checkPort(port);
          if (ready) break;
        }

        if (!ready) {
          throw new Error("Settings server failed to start");
        }
      }

      console.log(chalk.dim(`Opening ${url}\n`));
      await openBrowser(url);

      console.log(
        chalk.dim(
          "Complete the setup in your browser.\n" +
            "Press Ctrl+C when done, then run `nomos chat` to start.\n",
        ),
      );

      // Wait for user to press Ctrl+C or the wizard to complete
      await waitForSetupComplete(port);

      return;
    } catch {
      console.log(chalk.dim("Could not launch web wizard. Falling back to terminal setup.\n"));
    }
  }

  // Fallback: minimal terminal wizard for DATABASE_URL
  await runTerminalWizard();
}

/**
 * Minimal terminal wizard — only asks for DATABASE_URL and API key.
 * Used as fallback when the web wizard can't be launched.
 */
async function runTerminalWizard(): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const ask = (question: string, defaultValue?: string): Promise<string> => {
    const suffix = defaultValue ? chalk.dim(` [${defaultValue}]`) : "";
    return new Promise((resolve) => {
      rl.question(`${question}${suffix}: `, (answer) => {
        resolve(answer.trim() || defaultValue || "");
      });
    });
  };

  // 1. Database URL
  console.log(chalk.bold("1. Database"));
  console.log(
    chalk.dim(
      "  Nomos needs PostgreSQL with pgvector. Quick Docker setup:\n" +
        "  docker run -d --name nomos-db \\\n" +
        "    -e POSTGRES_USER=nomos -e POSTGRES_PASSWORD=nomos \\\n" +
        "    -e POSTGRES_DB=nomos -p 5432:5432 pgvector/pgvector:pg17\n",
    ),
  );
  const databaseUrl = await ask("  DATABASE_URL", "postgresql://nomos:nomos@localhost:5432/nomos");

  // 2. API Provider
  console.log();
  console.log(chalk.bold("2. API Provider"));
  const providerChoice = await ask(
    "  Use Anthropic API key or Vertex AI? (anthropic/vertex)",
    "anthropic",
  );

  let anthropicApiKey = "";
  let googleCloudProject = "";
  let cloudMlRegion = "";

  if (providerChoice.toLowerCase().startsWith("v")) {
    googleCloudProject = await ask("  GOOGLE_CLOUD_PROJECT");
    cloudMlRegion = await ask("  CLOUD_ML_REGION", "us-east5");
    console.log(chalk.dim("  Make sure to run: gcloud auth application-default login"));
  } else {
    anthropicApiKey = await ask("  ANTHROPIC_API_KEY");
  }

  // 3. Model
  console.log();
  console.log(chalk.bold("3. Model"));
  const model = await ask("  NOMOS_MODEL", "claude-sonnet-4-6");

  // Write .env
  const lines: string[] = ["# Nomos configuration", `DATABASE_URL=${databaseUrl}`, ""];

  if (anthropicApiKey) {
    lines.push(`ANTHROPIC_API_KEY=${anthropicApiKey}`);
  }
  if (googleCloudProject) {
    lines.push("CLAUDE_CODE_USE_VERTEX=1");
    lines.push(`GOOGLE_CLOUD_PROJECT=${googleCloudProject}`);
    if (cloudMlRegion) {
      lines.push(`CLOUD_ML_REGION=${cloudMlRegion}`);
    }
  }

  lines.push("", `NOMOS_MODEL=${model}`, "");

  const envPath = path.resolve(".env");
  fs.writeFileSync(envPath, lines.join("\n"), "utf-8");

  console.log();
  console.log(chalk.dim(`Wrote ${envPath}`));
  console.log(chalk.dim("You can edit this file anytime to change settings."));
  console.log(chalk.dim("\nFor the full setup wizard, run: cd settings && pnpm dev\n"));

  rl.close();
}

async function checkPort(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${port}/api/setup/status`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function openBrowser(url: string): Promise<void> {
  const platform = process.platform;
  try {
    if (platform === "darwin") {
      await execFileAsync("open", [url]);
    } else if (platform === "win32") {
      await execFileAsync("cmd", ["/c", "start", url]);
    } else {
      await execFileAsync("xdg-open", [url]);
    }
  } catch {
    console.log(chalk.dim(`Open this URL in your browser: ${url}`));
  }
}

async function waitForSetupComplete(port: number): Promise<void> {
  // Poll setup status every 3 seconds
  return new Promise((resolve) => {
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`http://localhost:${port}/api/setup/status`, {
          signal: AbortSignal.timeout(2000),
        });
        const data = (await res.json()) as { complete: boolean };
        if (data.complete) {
          clearInterval(interval);
          console.log(chalk.green("\nSetup complete!"));
          resolve();
        }
      } catch {
        // Server may have been stopped
      }
    }, 3000);

    // Also resolve on SIGINT
    process.once("SIGINT", () => {
      clearInterval(interval);
      console.log();
      resolve();
    });
  });
}

/**
 * Check if the setup wizard should run.
 * Returns true if .env is missing or lacks DATABASE_URL.
 *
 * In hosted mode, the wizard is replaced by the mobile onboarding flow +
 * admin-side provisioning, so it never auto-runs.
 */
/** True if the .env file at `envPath` defines a non-empty DATABASE_URL value. */
export function envHasDatabaseUrl(envPath: string): boolean {
  if (!fs.existsSync(envPath)) return false;
  const content = fs.readFileSync(envPath, "utf-8");
  // An actual DATABASE_URL value, not just a comment or an empty assignment.
  return content
    .split("\n")
    .some(
      (line) =>
        line.startsWith("DATABASE_URL=") && line.slice("DATABASE_URL=".length).trim().length > 0,
    );
}

export function shouldRunWizard(opts?: { cwd?: string; nomosEnv?: string }): boolean {
  if (!FEATURES.setupWizard()) return false;

  // Config can live in the CWD .env (a developer running from the repo) or in
  // ~/.nomos/.env (the installed binary's config home). If either defines a
  // DATABASE_URL the instance is already set up -- don't re-run the wizard just
  // because the current directory happens to have no .env.
  const cwdEnv = path.resolve(opts?.cwd ?? ".", ".env");
  const nomosEnv = opts?.nomosEnv ?? path.join(os.homedir(), ".nomos", ".env");
  return !envHasDatabaseUrl(cwdEnv) && !envHasDatabaseUrl(nomosEnv);
}
