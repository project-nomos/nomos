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
 * Sync accounts from gws auth status into the DB.
 * In v0.22.5+, gws supports one account at a time.
 * We add it to the DB but don't remove old accounts (user may re-auth them later).
 */
export async function syncGoogleAccountsFromGws(): Promise<GoogleAccountRow[]> {
  try {
    const { getGwsAuthStatus } = await import("../sdk/google-workspace-mcp.ts");
    const status = await getGwsAuthStatus();

    if (status.authenticated && status.email) {
      // Mark the current gws account as default, unmark others
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
  } catch {
    // gws not available -- return current DB state
  }

  return listGoogleAccounts();
}
