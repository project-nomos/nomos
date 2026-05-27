/**
 * Sync Google Workspace accounts from the on-disk manifest
 * (`~/.config/gws/accounts.json`) into the integrations table.
 *
 * The manifest, written by `src/lib/gws-accounts.ts` during the OAuth
 * flow, is the source of truth. The DB just caches it so other surfaces
 * (Settings UI status, agent system prompt) can read accounts without
 * touching the filesystem.
 *
 * Falls back to single-account `gws auth status` for legacy installs
 * whose manifest hasn't been populated yet — that path is removed once
 * the first multi-account auth migrates the install.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getDb } from "./db";
import { listAccounts } from "./gws-accounts";

const execFileAsync = promisify(execFile);

export async function syncGoogleAccountsToDb(): Promise<
  Array<{ email: string; is_default: boolean }>
> {
  const manifest = listAccounts();

  // Primary path: manifest-driven sync.
  if (manifest.length > 0) {
    const sql = getDb();

    const manifestEmails = new Set(manifest.map((a) => a.email));

    for (const acct of manifest) {
      const name = `google-ws:${acct.email}`;
      // Use `sql.json()` so the value is inserted as a proper JSONB object
      // (e.g. `{"is_default": true}`). Passing a `JSON.stringify(...)::jsonb`
      // string causes postgres.js to wrap it again, producing a JSONB
      // STRING like "{\"is_default\":true}" — the kind that breaks
      // `metadata->>'is_default'` lookups everywhere downstream.
      const metadataJson = sql.json({ is_default: acct.isDefault });
      await sql`
        INSERT INTO integrations (name, enabled, config, secrets, metadata)
        VALUES (${name}, true, '{}', '{}', ${metadataJson})
        ON CONFLICT (name) DO UPDATE SET
          metadata = ${metadataJson},
          updated_at = now()
      `;
    }

    // Drop stale DB rows for accounts no longer in the manifest.
    const existing = await sql<{ name: string }[]>`
      SELECT name FROM integrations WHERE name LIKE 'google-ws:%'
    `;
    for (const row of existing) {
      const email = row.name.replace(/^google-ws:/, "");
      if (!manifestEmails.has(email)) {
        await sql`DELETE FROM integrations WHERE name = ${row.name}`;
      }
    }

    return manifest.map((a) => ({ email: a.email, is_default: a.isDefault }));
  }

  // Legacy fallback: single-account gws auth status. Used by pre-migration
  // installs until the first multi-account auth populates the manifest.
  let authenticated = false;
  try {
    const { stdout } = await execFileAsync("npx", ["@googleworkspace/cli", "auth", "status"], {
      timeout: 10_000,
    });
    const status = JSON.parse(stdout);
    authenticated =
      status.auth_method !== "none" || status.token_cache_exists || status.storage !== "none";
  } catch {
    return [];
  }

  if (!authenticated) return [];

  let email: string | null = null;
  try {
    const { stdout: exportOut } = await execFileAsync(
      "npx",
      ["@googleworkspace/cli", "auth", "export", "--unmasked"],
      { timeout: 10_000 },
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

  const sql = getDb();
  const name = `google-ws:${email}`;
  const metadataJson = sql.json({ is_default: true });

  await sql`
    INSERT INTO integrations (name, enabled, config, secrets, metadata)
    VALUES (${name}, true, '{}', '{}', ${metadataJson})
    ON CONFLICT (name) DO UPDATE SET
      metadata = ${metadataJson},
      updated_at = now()
  `;

  return [{ email, is_default: true }];
}
