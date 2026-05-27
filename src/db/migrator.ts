/**
 * Shared schema + migration logic. Used by both the `nomos db` CLI and the
 * Better Auth admin/provisioning server to create per-customer Postgres
 * schemas and apply the canonical schema.sql idempotently.
 *
 * Schema names are validated against a strict regex to prevent SQL
 * injection — only `nomos_<lower_alphanumeric_or_underscore>` is allowed.
 *
 * Each customer instance runs against a dedicated schema (e.g., `nomos_abc123`).
 * The `search_path` is set per-connection from the `NOMOS_DB_SCHEMA` env var
 * (see `src/db/client.ts`). Power-user mode leaves `NOMOS_DB_SCHEMA` unset,
 * which means the default `public` schema is used.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type postgres from "postgres";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Optional override of the canonical schema, used by callers that already have it in memory. */
let injectedSchemaSql: string | null = null;
export function setSchemaSqlOverride(sql: string | null): void {
  injectedSchemaSql = sql;
}

/** Allowed schema name pattern. Must start with `nomos_` to make ownership obvious. */
const SCHEMA_NAME_PATTERN = /^nomos_[a-z0-9_]{1,48}$/;

/** Schema names that are reserved for system use. */
const RESERVED_SCHEMAS = new Set(["nomos_admin", "nomos_system", "nomos_meta"]);

export function isValidSchemaName(name: string): boolean {
  if (!SCHEMA_NAME_PATTERN.test(name)) return false;
  if (RESERVED_SCHEMAS.has(name)) return false;
  return true;
}

export function assertValidSchemaName(name: string): void {
  if (!isValidSchemaName(name)) {
    throw new Error(
      `Invalid schema name "${name}". Must match /^nomos_[a-z0-9_]{1,48}$/ and not be reserved.`,
    );
  }
}

/**
 * Resolve the canonical schema.sql contents. Tries (1) an explicit override
 * set via setSchemaSqlOverride(), (2) on-disk schema.sql next to this file,
 * (3) throws — bundled callers must provide the override.
 */
function resolveSchemaSql(): string {
  if (injectedSchemaSql) return injectedSchemaSql;
  const schemaPath = path.join(__dirname, "schema.sql");
  try {
    return fs.readFileSync(schemaPath, "utf-8");
  } catch {
    throw new Error(
      "schema.sql not found on disk and no inline override provided. " +
        "Call setSchemaSqlOverride() before applySchema() in bundled builds.",
    );
  }
}

/**
 * Create a per-customer schema. Idempotent.
 */
export async function createSchema(sql: postgres.Sql, schemaName: string): Promise<void> {
  assertValidSchemaName(schemaName);
  await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${schemaName}`);
}

/**
 * Drop a per-customer schema and ALL its data. Destructive — use only for
 * GDPR-delete or admin teardown flows.
 */
export async function dropSchema(sql: postgres.Sql, schemaName: string): Promise<void> {
  assertValidSchemaName(schemaName);
  await sql.unsafe(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
}

/**
 * Apply the canonical schema (all CREATE TABLE IF NOT EXISTS / indexes /
 * extensions) to the given schema. Idempotent.
 *
 * When `schemaName` is null/undefined, applies to the `public` schema
 * (current behavior for power-user mode).
 *
 * @param schemaSql Optional override of the schema content. When omitted,
 *   reads from src/db/schema.sql at runtime.
 */
export async function applySchema(
  sql: postgres.Sql,
  schemaName?: string | null,
  schemaSql?: string,
): Promise<void> {
  const content = schemaSql ?? resolveSchemaSql();
  if (schemaName) {
    assertValidSchemaName(schemaName);
    await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${schemaName}`);
    // Set search_path for the duration of this connection's transaction.
    // pgvector's `vector` type lives in the extension's schema (usually
    // `public`), but tables in any schema can reference it because pg
    // resolves types through `search_path` at parse time.
    await sql.unsafe(`SET LOCAL search_path TO ${schemaName}, public`);
  }
  await sql.unsafe(content);
}

/**
 * Convenience: create the schema (if missing) and apply migrations. Used by
 * the admin provisioning server when spinning up a new customer instance.
 */
export async function provisionSchema(sql: postgres.Sql, schemaName: string): Promise<void> {
  assertValidSchemaName(schemaName);
  await createSchema(sql, schemaName);
  await applySchema(sql, schemaName);
}
