/**
 * Google Workspace account persistence.
 *
 * Stores account metadata in the integrations table using "google-ws:{email}"
 * naming. The actual OAuth tokens remain with the `gws` CLI (~/.config/gws/).
 *
 * In gws v0.22.5+ there is at most one authenticated account.
 * We persist which accounts have been authorized so the agent can reference them.
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
 * Add or update a Google account in the DB.
 */
export async function upsertGoogleAccount(email: string, isDefault: boolean): Promise<void> {
  await upsertIntegration(integrationName(email), {
    metadata: { is_default: isDefault },
  });
}

/**
 * Remove a Google account from the DB.
 */
export async function removeGoogleAccount(email: string): Promise<void> {
  await removeIntegration(integrationName(email));
}

/**
 * Sync accounts from the on-disk gws multi-account manifest
 * (`~/.config/gws/accounts.json`, managed by `src/auth/gws-accounts.ts`)
 * into the DB. The manifest is the source of truth; the DB caches it so
 * other surfaces (Settings UI, system prompt) can read accounts without
 * touching the filesystem.
 *
 * Falls back to the legacy single-account `gws auth status` path if the
 * manifest is empty (so existing single-account installs keep working
 * until the next auth flow migrates them to the manifest).
 */
export async function syncGoogleAccountsFromGws(): Promise<GoogleAccountRow[]> {
  try {
    const { listAccounts } = await import("../auth/gws-accounts.ts");
    const manifest = listAccounts();

    if (manifest.length > 0) {
      const manifestEmails = new Set(manifest.map((a) => a.email));

      // Upsert every manifest account.
      for (const acct of manifest) {
        await upsertIntegration(integrationName(acct.email), {
          metadata: { is_default: acct.isDefault },
        });
      }

      // Drop DB rows for accounts that no longer exist in the manifest.
      const existing = await listGoogleAccounts();
      for (const acct of existing) {
        if (!manifestEmails.has(acct.email)) {
          await removeIntegration(integrationName(acct.email));
        }
      }
    } else {
      // No manifest yet — fall back to the legacy single-account path so
      // pre-migration installs continue to work until the user runs the
      // multi-account auth flow.
      const { getGwsAuthStatus } = await import("../sdk/google-workspace-mcp.ts");
      const status = await getGwsAuthStatus();
      if (status.authenticated && status.email) {
        const existing = await listGoogleAccounts();
        for (const account of existing) {
          if (account.is_default && account.email !== status.email) {
            await upsertIntegration(integrationName(account.email), {
              metadata: { is_default: false },
            });
          }
        }
        await upsertIntegration(integrationName(status.email), {
          metadata: { is_default: true },
        });
      }
    }
  } catch {
    // Manifest/gws not available -- return current DB state
  }

  return listGoogleAccounts();
}
