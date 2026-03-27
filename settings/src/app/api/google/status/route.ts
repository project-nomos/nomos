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
    gwsVersion = stdout
      .trim()
      .replace(/^gws\s+/, "")
      .split("\n")[0];
  } catch {
    // gws not available
  }

  // Get authenticated accounts from gws
  const accounts: Array<{ email: string; default: boolean }> = [];
  let hasValidToken = false;
  if (gwsInstalled) {
    // Try auth list first
    try {
      const { stdout } = await execFileAsync("npx", ["gws", "auth", "list"], { timeout: 10000 });
      const data = JSON.parse(stdout);
      const defaultAccount = data.default ?? "";
      for (const entry of data.accounts ?? []) {
        // gws auth list returns either strings or objects with { email, is_default, added }
        const email = typeof entry === "string" ? entry : entry.email;
        if (email) {
          accounts.push({ email, default: email === defaultAccount });
        }
      }
    } catch {
      // No accounts or gws auth not set up
    }

    // Also check auth status — credentials may exist without being listed
    if (accounts.length === 0) {
      try {
        const { stdout } = await execFileAsync("npx", ["gws", "auth", "status"], {
          timeout: 10000,
        });
        const status = JSON.parse(stdout);
        if (status.has_refresh_token && status.token_valid) {
          hasValidToken = true;
          // Get the email by exchanging refresh token for access token and calling userinfo
          try {
            const { stdout: exportOut } = await execFileAsync(
              "npx",
              ["gws", "auth", "export", "--unmasked"],
              { timeout: 10000 },
            );
            const creds = JSON.parse(exportOut);
            if (creds.refresh_token && creds.client_id && creds.client_secret) {
              // Exchange refresh token for access token
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
                let email: string | null = null;

                // Try userinfo (works if openid+email scopes were granted)
                try {
                  const userRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
                    headers: { Authorization: `Bearer ${tokenData.access_token}` },
                  });
                  if (userRes.ok) {
                    const info = await userRes.json();
                    if (info.email) email = info.email;
                  }
                } catch {
                  // Scope not available
                }

                // Fallback: try tokeninfo (has email if openid scope present)
                if (!email) {
                  try {
                    const tiRes = await fetch(
                      `https://oauth2.googleapis.com/tokeninfo?access_token=${tokenData.access_token}`,
                    );
                    if (tiRes.ok) {
                      const ti = await tiRes.json();
                      if (ti.email) email = ti.email;
                    }
                  } catch {
                    // Not available
                  }
                }

                // Fallback: try Gmail profile (works if Gmail API is enabled)
                if (!email) {
                  try {
                    const gmailRes = await fetch(
                      "https://gmail.googleapis.com/gmail/v1/users/me/profile",
                      { headers: { Authorization: `Bearer ${tokenData.access_token}` } },
                    );
                    if (gmailRes.ok) {
                      const profile = await gmailRes.json();
                      if (profile.emailAddress) email = profile.emailAddress;
                    }
                  } catch {
                    // Gmail API not enabled
                  }
                }

                if (email) {
                  accounts.push({ email, default: true });
                }
              }
            }
          } catch {
            // Could not resolve email — hasValidToken is still true
          }
        }
      } catch {
        // auth status not available
      }
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
