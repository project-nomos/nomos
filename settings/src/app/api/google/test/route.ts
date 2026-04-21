import { NextResponse } from "next/server";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function POST() {
  // Check if gws binary is available
  try {
    const { stdout } = await execFileAsync("npx", ["gws", "--version"], { timeout: 10000 });
    const version = stdout
      .trim()
      .replace(/^gws\s+/, "")
      .split("\n")[0];

    // Check auth status
    try {
      const { stdout: statusOut } = await execFileAsync("npx", ["gws", "auth", "status"], {
        timeout: 10000,
      });
      const status = JSON.parse(statusOut);

      if (
        status.auth_method === "none" &&
        !status.token_cache_exists &&
        status.storage === "none"
      ) {
        return NextResponse.json({
          ok: false,
          message: `gws ${version} is available but no account is authorized. Click "Authorize Account" to connect.`,
        });
      }
    } catch {
      return NextResponse.json({
        ok: false,
        message: `gws ${version} is available but auth status could not be determined.`,
      });
    }

    // Try a lightweight API call to verify token refresh works
    try {
      await execFileAsync(
        "npx",
        ["gws", "gmail", "users", "getProfile", "--params", '{"userId":"me"}'],
        { timeout: 15000 },
      );
      return NextResponse.json({
        ok: true,
        message: `gws ${version} ready -- API access verified`,
      });
    } catch (apiErr) {
      const errMsg = apiErr instanceof Error ? apiErr.message : String(apiErr);
      if (errMsg.includes("401") || errMsg.includes("credentials") || errMsg.includes("auth")) {
        return NextResponse.json({
          ok: false,
          message: `gws ${version} has credentials but tokens are invalid. Re-authorize by clicking "Authorize Account".`,
        });
      }
      // Non-auth error (API not enabled, project mismatch, etc.) -- auth itself is fine
      return NextResponse.json({
        ok: true,
        message: `gws ${version} ready -- authenticated`,
      });
    }
  } catch {
    return NextResponse.json({
      ok: false,
      message: "gws CLI not available. Ensure @googleworkspace/cli is installed.",
    });
  }
}
