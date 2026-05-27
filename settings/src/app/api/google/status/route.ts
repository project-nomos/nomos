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

  // Verify the gws-stored credentials can actually mint a fresh access
  // token. `auth status` only reports whether credentials exist in the
  // keyring — it returns "authenticated" even when the refresh_token is
  // tied to a different OAuth client than what's now on disk (in which
  // case Google rejects refresh with `invalid_client`).
  let tokenError: string | null = null;
  if (gwsInstalled) {
    try {
      const { stdout } = await execFileAsync("npx", ["@googleworkspace/cli", "auth", "status"], {
        timeout: 10000,
      });
      const status = JSON.parse(stdout);
      const hasCredsInKeyring =
        status.auth_method !== "none" || status.token_cache_exists || status.storage !== "none";

      if (hasCredsInKeyring) {
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
              hasValidToken = true;
              const tokenData = await tokenRes.json();
              // If no accounts in DB yet, resolve email from userinfo.
              if (accounts.length === 0) {
                try {
                  const userRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
                    headers: { Authorization: `Bearer ${tokenData.access_token}` },
                  });
                  if (userRes.ok) {
                    const info = await userRes.json();
                    if (info.email) accounts.push({ email: info.email, default: true });
                  }
                } catch {
                  // openid scope may not be granted; non-fatal
                }
              }
            } else {
              // Refresh failed — parse Google's error response for an
              // actionable reason. Common cases:
              //   invalid_client: refresh_token tied to a different
              //     OAuth client than the one in client_secret.json
              //     (usually after credentials were rotated/rewritten).
              //   invalid_grant: refresh token expired or revoked.
              let oauthError: string | null = null;
              try {
                const errJson = await tokenRes.json();
                oauthError = errJson?.error ?? null;
              } catch {
                // ignore
              }
              tokenError = oauthError ?? `HTTP ${tokenRes.status} from Google token endpoint`;
            }
          } else {
            tokenError = "gws keyring is missing refresh_token or client credentials";
          }
        } catch (err) {
          tokenError = err instanceof Error ? err.message : String(err);
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
    tokenError,
    services,
    clientId: !!env.GOOGLE_OAUTH_CLIENT_ID,
    clientSecret: !!env.GOOGLE_OAUTH_CLIENT_SECRET,
  });
}
