import { NextResponse } from "next/server";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readEnv } from "@/lib/env";

const execFileAsync = promisify(execFile);

export async function GET() {
  const env = readEnv();

  // Check gws binary availability
  let gwsInstalled = false;
  let gwsVersion = "";
  try {
    const { stdout } = await execFileAsync("npx", ["gws", "--version"], { timeout: 10000 });
    gwsInstalled = true;
    gwsVersion = stdout.trim().replace(/^gws\s+/, "").split("\n")[0];
  } catch {
    // gws not available
  }

  // Get authenticated accounts from gws
  const accounts: Array<{ email: string; default: boolean }> = [];
  if (gwsInstalled) {
    try {
      const { stdout } = await execFileAsync("npx", ["gws", "auth", "list"], { timeout: 10000 });
      const data = JSON.parse(stdout);
      const defaultAccount = data.default ?? "";
      for (const email of data.accounts ?? []) {
        accounts.push({ email, default: email === defaultAccount });
      }
    } catch {
      // No accounts or gws auth not set up
    }
  }

  const services = env.GWS_SERVICES ?? "all";

  return NextResponse.json({
    configured: accounts.length > 0 || !!(env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET),
    gwsInstalled,
    gwsVersion,
    accounts,
    services,
    clientId: !!env.GOOGLE_OAUTH_CLIENT_ID,
    clientSecret: !!env.GOOGLE_OAUTH_CLIENT_SECRET,
  });
}
