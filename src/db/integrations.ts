/**
 * CRUD operations for the integrations table.
 *
 * Stores per-integration config (plaintext JSONB), secrets (encrypted TEXT),
 * and metadata (plaintext JSONB). Secrets are encrypted at rest using
 * AES-256-GCM when ENCRYPTION_KEY is configured.
 */

import { getDb } from "./client.ts";
import { encrypt, decrypt } from "./encryption.ts";

export interface Integration {
  id: string;
  name: string;
  enabled: boolean;
  config: Record<string, unknown>;
  secrets: Record<string, string>;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

interface IntegrationRow {
  id: string;
  name: string;
  enabled: boolean;
  config: Record<string, unknown>;
  secrets: string;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

function rowToIntegration(row: IntegrationRow): Integration {
  let secrets: Record<string, string> = {};
  if (row.secrets) {
    try {
      const decrypted = decrypt(row.secrets);
      secrets = JSON.parse(decrypted);
    } catch {
      // If decryption or parsing fails, return empty secrets
      secrets = {};
    }
  }
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled,
    config: row.config,
    secrets,
    metadata: row.metadata,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function encryptSecrets(secrets: Record<string, string>): string {
  const json = JSON.stringify(secrets);
  return encrypt(json);
}

export async function upsertIntegration(
  name: string,
  params: {
    config?: Record<string, unknown>;
    secrets?: Record<string, string>;
    metadata?: Record<string, unknown>;
    enabled?: boolean;
  },
): Promise<Integration> {
  const sql = getDb();
  const secretsStr = params.secrets ? encryptSecrets(params.secrets) : "";
  const configObj = (params.config ?? {}) as Record<string, never>;
  const metadataObj = (params.metadata ?? {}) as Record<string, never>;
  const enabled = params.enabled ?? true;

  const [row] = await sql<IntegrationRow[]>`
    INSERT INTO integrations (name, enabled, config, secrets, metadata)
    VALUES (
      ${name},
      ${enabled},
      ${sql.json(configObj)},
      ${secretsStr},
      ${sql.json(metadataObj)}
    )
    ON CONFLICT (name) DO UPDATE SET
      enabled = COALESCE(${params.enabled ?? null}::boolean, integrations.enabled),
      config = CASE WHEN ${params.config !== undefined} THEN ${sql.json(configObj)} ELSE integrations.config END,
      secrets = CASE WHEN ${params.secrets !== undefined} THEN ${secretsStr} ELSE integrations.secrets END,
      metadata = CASE WHEN ${params.metadata !== undefined} THEN ${sql.json(metadataObj)} ELSE integrations.metadata END,
      updated_at = now()
    RETURNING *
  `;
  return rowToIntegration(row);
}

export async function getIntegration(name: string): Promise<Integration | null> {
  const sql = getDb();
  const [row] = await sql<IntegrationRow[]>`
    SELECT * FROM integrations WHERE name = ${name}
  `;
  return row ? rowToIntegration(row) : null;
}

export async function listIntegrations(): Promise<Integration[]> {
  const sql = getDb();
  const rows = await sql<IntegrationRow[]>`
    SELECT * FROM integrations ORDER BY name
  `;
  return rows.map(rowToIntegration);
}

export async function listIntegrationsByPrefix(prefix: string): Promise<Integration[]> {
  const sql = getDb();
  const rows = await sql<IntegrationRow[]>`
    SELECT * FROM integrations WHERE name LIKE ${prefix + "%"} ORDER BY name
  `;
  return rows.map(rowToIntegration);
}

export async function removeIntegration(name: string): Promise<Integration | null> {
  const sql = getDb();
  const [row] = await sql<IntegrationRow[]>`
    DELETE FROM integrations WHERE name = ${name} RETURNING *
  `;
  return row ? rowToIntegration(row) : null;
}

/**
 * Convenience helper: check DB integration secret, fall back to env var.
 * Useful for SDK modules that need a single secret value.
 */
export async function getSecretOrEnv(
  name: string,
  secretKey: string,
  envVar: string,
): Promise<string | undefined> {
  try {
    const integration = await getIntegration(name);
    if (integration?.enabled && integration.secrets[secretKey]) {
      return integration.secrets[secretKey];
    }
  } catch {
    // DB not available — fall through to env
  }
  return process.env[envVar] || undefined;
}
