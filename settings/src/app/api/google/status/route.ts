import { NextResponse } from "next/server";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readConfig } from "@/lib/env";
import { getDb } from "@/lib/db";

const execFileAsync = promisify(execFile);

export async function GET() {
  let sql: ReturnType<typeof getDb> | undefined;
  try {
    sql = getDb();
  } catch {
    // DB not available
  }
  const env = await readConfig(
    ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET", "GWS_SERVICES"],
    sql,
  );

  // Check gws binary availability
  let gwsInstalled = false;
  let gwsVersion = "";
  try {
    const { stdout } = await execFileAsync("npx", ["@googleworkspace/cli", "--version"], {
      timeout: 10000,
    });
    gwsInstalled = true;
    gwsVersion = stdout
      .trim()
      .replace(/^gws\s+/, "")
      .split("\n")[0];
  } catch {
    // gws not available
  }

  // Get accounts from DB
  const accounts: Array<{ email: string; default: boolean }> = [];
  let hasValidToken = false;

  if (sql) {
    try {
      const rows = await sql`
        SELECT name, metadata FROM integrations
        WHERE name LIKE 'google-ws:%' AND enabled = true
        ORDER BY metadata->>'is_default' DESC, name
      `;
      for (const row of rows) {
        const email = (row.name as string).replace(/^google-ws:/, "");
        const meta = row.metadata as Record<string, unknown>;
        accounts.push({ email, default: !!meta?.is_default });
      }
    } catch {
      // integrations table may not exist
    }
  }

  // Check gws auth status for token validity
  if (gwsInstalled) {
    try {
      const { stdout } = await execFileAsync("npx", ["@googleworkspace/cli", "auth", "status"], {
        timeout: 10000,
      });
      const status = JSON.parse(stdout);
      if (status.auth_method !== "none" || status.token_cache_exists || status.storage !== "none") {
        hasValidToken = true;

        // If no accounts in DB, try to resolve email from token
        if (accounts.length === 0) {
          try {
            const { stdout: exportOut } = await execFileAsync(
              "npx",
              ["@googleworkspace/cli", "auth", "export", "--unmasked"],
              { timeout: 10000 },
            );
            const creds = JSON.parse(exportOut);
            if (creds.refresh_token && creds.client_id && creds.client_secret) {
              const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams({
                  client_id: creds.client_id,
                  client_secret: creds.client_secret,
                  refresh_token: creds.refresh_token,
                  grant_type: "refresh_token",
                }),
              });
              if (tokenRes.ok) {
                const tokenData = await tokenRes.json();
                // Try userinfo
                try {
                  const userRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
                    headers: { Authorization: `Bearer ${tokenData.access_token}` },
                  });
                  if (userRes.ok) {
                    const info = await userRes.json();
                    if (info.email) {
                      accounts.push({ email: info.email, default: true });
                    }
                  }
                } catch {
                  // Scope not available
                }
              }
            }
          } catch {
            // Could not resolve email
          }
        }
      }
    } catch {
      // auth status not available
    }
  }

  const services = env.GWS_SERVICES ?? "all";

  return NextResponse.json({
    configured:
      accounts.length > 0 ||
      hasValidToken ||
      !!(env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET),
    gwsInstalled,
    gwsVersion,
    accounts,
    hasValidToken,
    services,
    clientId: !!env.GOOGLE_OAUTH_CLIENT_ID,
    clientSecret: !!env.GOOGLE_OAUTH_CLIENT_SECRET,
  });
}
