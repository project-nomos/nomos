/**
 * Google Workspace account persistence.
 *
 * Syncs account metadata from `gws auth list` into the integrations table
 * using "google-ws:{email}" naming. The actual OAuth tokens remain with
 * the `gws` CLI (~/.config/gws/); we only persist which accounts are
 * authorized so the agent can reference them.
 */

import {
  upsertIntegration,
  listIntegrationsByPrefix,
  removeIntegration,
  type Integration,
} from "./integrations.ts";

export interface GoogleAccountRow {
  id: string;
  email: string;
  is_default: boolean;
  created_at: Date;
  updated_at: Date;
}

function integrationName(email: string): string {
  return `google-ws:${email}`;
}

function toAccountRow(integration: Integration, email: string): GoogleAccountRow {
  return {
    id: integration.id,
    email,
    is_default: (integration.metadata.is_default as boolean) ?? false,
    created_at: integration.created_at,
    updated_at: integration.updated_at,
  };
}

function extractEmail(name: string): string {
  return name.replace(/^google-ws:/, "");
}

export async function listGoogleAccounts(): Promise<GoogleAccountRow[]> {
  const integrations = await listIntegrationsByPrefix("google-ws:");
  return integrations.map((i) => toAccountRow(i, extractEmail(i.name)));
}

/**
 * Sync accounts from `gws auth list` output into the DB.
 *
 * - Adds new accounts that appear in gws but not in DB
 * - Removes accounts from DB that are no longer in gws
 * - Updates default status
 */
export async function syncGoogleAccountsFromGws(): Promise<GoogleAccountRow[]> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);

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
    // gws not available — return current DB state
    return listGoogleAccounts();
  }

  const gwsEmails = new Set(gwsAccounts.map((a) => a.email));

  // Remove DB entries that are no longer in gws
  const existing = await listGoogleAccounts();
  for (const account of existing) {
    if (!gwsEmails.has(account.email)) {
      await removeIntegration(integrationName(account.email));
    }
  }

  // Upsert all gws accounts
  for (const account of gwsAccounts) {
    await upsertIntegration(integrationName(account.email), {
      metadata: { is_default: account.isDefault },
    });
  }

  return listGoogleAccounts();
}
