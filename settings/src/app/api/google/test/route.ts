import { NextResponse } from "next/server";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function POST() {
  // Check if gws binary is available
  try {
    const { stdout } = await execFileAsync("npx", ["gws", "--version"], { timeout: 10000 });
    const version = stdout.trim();

    // Check if auth is configured
    const { stdout: authOut } = await execFileAsync("npx", ["gws", "auth", "list"], {
      timeout: 10000,
    });
    const authData = JSON.parse(authOut);
    const accountCount = authData.count ?? 0;

    if (accountCount === 0) {
      return NextResponse.json({
        ok: false,
        message: `gws is available (${version}) but no accounts are authorized. Click "Authorize" to add an account.`,
      });
    }

    return NextResponse.json({
      ok: true,
      message: `gws ${version} ready with ${accountCount} authorized account(s)`,
    });
  } catch {
    return NextResponse.json({
      ok: false,
      message: "gws CLI not available. Ensure @googleworkspace/cli is installed.",
    });
  }
}
