/**
 * Sync Google Workspace account from `gws auth status` into the DB.
 *
 * The `gws` CLI owns OAuth tokens (~/.config/gws/). We persist account
 * metadata (email, default status) in the integrations table so the agent
 * can reference which Google accounts are available.
 *
 * In gws v0.22.5+, there is at most one authenticated account.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getDb } from "./db";

const execFileAsync = promisify(execFile);

export async function syncGoogleAccountsToDb(): Promise<
  Array<{ email: string; is_default: boolean }>
> {
  // Check if gws has a valid auth session
  let authenticated = false;
  try {
    const { stdout } = await execFileAsync("npx", ["gws", "auth", "status"], { timeout: 10000 });
    const status = JSON.parse(stdout);
    authenticated =
      status.auth_method !== "none" || status.token_cache_exists || status.storage !== "none";
  } catch {
    return [];
  }

  if (!authenticated) return [];

  // Try to resolve the email of the authenticated account
  let email: string | null = null;
  try {
    const { stdout: exportOut } = await execFileAsync(
      "npx",
      ["gws", "auth", "export", "--unmasked"],
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
        try {
          const userRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
            headers: { Authorization: `Bearer ${tokenData.access_token}` },
          });
          if (userRes.ok) {
            const info = await userRes.json();
            if (info.email) email = info.email;
          }
        } catch {
          // openid scope not available
        }
      }
    }
  } catch {
    // Could not export credentials
  }

  if (!email) return [];

  // Upsert the account in DB
  const sql = getDb();
  const name = `google-ws:${email}`;
  const metadata = JSON.stringify({ is_default: true });

  await sql`
    INSERT INTO integrations (name, enabled, config, secrets, metadata)
    VALUES (${name}, true, '{}', '{}', ${metadata}::jsonb)
    ON CONFLICT (name) DO UPDATE SET
      metadata = ${metadata}::jsonb,
      updated_at = now()
  `;

  return [{ email, is_default: true }];
}
