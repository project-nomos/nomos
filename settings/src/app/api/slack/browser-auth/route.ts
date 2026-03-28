import { NextResponse } from "next/server";
import { spawn, execSync } from "node:child_process";
import path from "node:path";

// Track active browser auth process
let activeProcess: ReturnType<typeof spawn> | null = null;
let processOutput: string[] = [];

/**
 * POST /api/slack/browser-auth
 *
 * Launches `nomos slack auth` in a child process, which opens a Playwright
 * browser for the user to sign into Slack. Tokens are captured automatically
 * and stored in the DB. The Settings UI polls /api/slack/workspaces to detect
 * new workspaces.
 */
export async function POST() {
  // Kill any existing auth process
  if (activeProcess) {
    activeProcess.kill();
    activeProcess = null;
  }

  processOutput = [];

  try {
    const rootDir = path.resolve(process.cwd(), "..");
    const entryPoint = path.resolve(rootDir, "src", "index.ts");

    // Find tsx binary — try local node_modules first, then npx
    let tsxBin: string;
    try {
      tsxBin = execSync("which tsx", { encoding: "utf-8", cwd: rootDir }).trim();
    } catch {
      // Fall back to node_modules/.bin/tsx
      tsxBin = path.resolve(rootDir, "node_modules", ".bin", "tsx");
    }

    const child = spawn(tsxBin, [entryPoint, "slack", "auth"], {
      cwd: rootDir,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        // Ensure dotenv files are found relative to root
        NODE_ENV: process.env.NODE_ENV,
      },
      detached: false,
    });

    activeProcess = child;

    // Capture output for debugging
    child.stdout?.on("data", (data: Buffer) => {
      const line = data.toString().trim();
      if (line) processOutput.push(line);
      console.log("[browser-auth] stdout:", line);
    });

    child.stderr?.on("data", (data: Buffer) => {
      const line = data.toString().trim();
      if (line) processOutput.push(`[err] ${line}`);
      console.error("[browser-auth] stderr:", line);
    });

    // Send "a" (all workspaces) to stdin periodically in case it prompts for selection
    const stdinInterval = setInterval(() => {
      try {
        child.stdin?.write("a\n");
      } catch {
        clearInterval(stdinInterval);
      }
    }, 5_000);

    // Auto-cleanup after 3 minutes
    const killTimer = setTimeout(() => {
      if (activeProcess === child) {
        child.kill();
        activeProcess = null;
      }
    }, 180_000);

    child.on("exit", (code) => {
      clearTimeout(killTimer);
      clearInterval(stdinInterval);
      console.log(`[browser-auth] Process exited with code ${code}`);
      if (activeProcess === child) {
        activeProcess = null;
      }
    });

    child.on("error", (err) => {
      console.error("[browser-auth] Process error:", err);
      processOutput.push(`[error] ${err.message}`);
      clearTimeout(killTimer);
      clearInterval(stdinInterval);
      if (activeProcess === child) {
        activeProcess = null;
      }
    });

    return NextResponse.json({
      ok: true,
      message: "Browser window opened — sign in to Slack. Workspaces will appear automatically.",
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Failed to launch browser";
    console.error("[browser-auth] Failed to start:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

/**
 * GET /api/slack/browser-auth
 *
 * Check status and get process output (for debugging).
 */
export async function GET() {
  return NextResponse.json({
    active: !!activeProcess,
    output: processOutput.slice(-20),
  });
}

/**
 * DELETE /api/slack/browser-auth
 *
 * Cancel an in-progress browser auth session.
 */
export async function DELETE() {
  if (activeProcess) {
    activeProcess.kill();
    activeProcess = null;
    return NextResponse.json({ ok: true, message: "Browser auth cancelled" });
  }
  return NextResponse.json({ ok: true, message: "No active browser auth session" });
}
