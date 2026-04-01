/**
 * Sync Google Workspace accounts from `gws auth list` into the DB.
 *
 * The `gws` CLI owns OAuth tokens (~/.config/gws/). We persist account
 * metadata (email, default status) in the integrations table so the agent
 * can reference which Google accounts are available.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getDb } from "./db";

const execFileAsync = promisify(execFile);

export async function syncGoogleAccountsToDb(): Promise<
  Array<{ email: string; is_default: boolean }>
> {
  // Get accounts from gws CLI
  let gwsAccounts: Array<{ email: string; isDefault: boolean }> = [];

  try {
    const { stdout } = await execFileAsync("npx", ["gws", "auth", "list"], { timeout: 10000 });
    const data = JSON.parse(stdout);
    const defaultAccount = data.default ?? "";
    for (const entry of data.accounts ?? []) {
      const email = typeof entry === "string" ? entry : entry.email;
      if (email) {
        gwsAccounts.push({ email, isDefault: email === defaultAccount });
      }
    }
  } catch {
    return [];
  }

  const sql = getDb();
  const gwsEmails = new Set(gwsAccounts.map((a) => a.email));

  // Remove DB entries no longer in gws
  const existing = await sql`
    SELECT name FROM integrations
    WHERE name LIKE 'google-ws:%' AND enabled = true
  `;

  for (const row of existing) {
    const email = (row.name as string).replace(/^google-ws:/, "");
    if (!gwsEmails.has(email)) {
      await sql`DELETE FROM integrations WHERE name = ${row.name as string}`;
    }
  }

  // Upsert all gws accounts
  for (const account of gwsAccounts) {
    const name = `google-ws:${account.email}`;
    const metadata = JSON.stringify({ is_default: account.isDefault });

    await sql`
      INSERT INTO integrations (name, enabled, config, secrets, metadata)
      VALUES (${name}, true, '{}', '{}', ${metadata}::jsonb)
      ON CONFLICT (name) DO UPDATE SET
        metadata = ${metadata}::jsonb,
        updated_at = now()
    `;
  }

  return gwsAccounts.map((a) => ({ email: a.email, is_default: a.isDefault }));
}
