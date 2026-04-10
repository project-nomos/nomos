/**
 * CRUD operations for the integrations table.
 *
 * Stores per-integration config (plaintext JSONB), secrets (encrypted TEXT),
 * and metadata (plaintext JSONB). Secrets are encrypted at rest using
 * AES-256-GCM when ENCRYPTION_KEY is configured.
 */

import { sql } from "kysely";
import { getKysely } from "./client.ts";
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
  const db = getKysely();
  const secretsStr = params.secrets ? encryptSecrets(params.secrets) : "";
  const configJson = JSON.stringify(params.config ?? {});
  const metadataJson = JSON.stringify(params.metadata ?? {});
  const enabled = params.enabled ?? true;

  const row = await db
    .insertInto("integrations")
    .values({
      name,
      enabled,
      config: configJson,
      secrets: secretsStr,
      metadata: metadataJson,
    })
    .onConflict((oc) =>
      oc.column("name").doUpdateSet({
        enabled: sql`COALESCE(${params.enabled ?? null}::boolean, integrations.enabled)`,
        config: sql`CASE WHEN ${params.config !== undefined} THEN ${configJson}::jsonb ELSE integrations.config END`,
        secrets: sql`CASE WHEN ${params.secrets !== undefined} THEN ${secretsStr} ELSE integrations.secrets END`,
        metadata: sql`CASE WHEN ${params.metadata !== undefined} THEN ${metadataJson}::jsonb ELSE integrations.metadata END`,
        updated_at: sql`now()`,
      }),
    )
    .returningAll()
    .executeTakeFirstOrThrow();
  return rowToIntegration(row as unknown as IntegrationRow);
}

export async function getIntegration(name: string): Promise<Integration | null> {
  const db = getKysely();
  const row = await db
    .selectFrom("integrations")
    .selectAll()
    .where("name", "=", name)
    .executeTakeFirst();
  return row ? rowToIntegration(row as unknown as IntegrationRow) : null;
}

export async function listIntegrations(): Promise<Integration[]> {
  const db = getKysely();
  const rows = await db.selectFrom("integrations").selectAll().orderBy("name").execute();
  return rows.map((r) => rowToIntegration(r as unknown as IntegrationRow));
}

export async function listIntegrationsByPrefix(prefix: string): Promise<Integration[]> {
  const db = getKysely();
  const rows = await db
    .selectFrom("integrations")
    .selectAll()
    .where("name", "like", `${prefix}%`)
    .orderBy("name")
    .execute();
  return rows.map((r) => rowToIntegration(r as unknown as IntegrationRow));
}

export async function removeIntegration(name: string): Promise<Integration | null> {
  const db = getKysely();
  const row = await db
    .deleteFrom("integrations")
    .where("name", "=", name)
    .returningAll()
    .executeTakeFirst();
  return row ? rowToIntegration(row as unknown as IntegrationRow) : null;
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
