/**
 * Shared database + migration logic. Used by both the `nomos db` CLI and the
 * Better Auth admin/provisioning server to create per-customer Postgres
 * databases and apply the canonical schema.sql idempotently.
 *
 * Architecture: database-per-customer. Each customer instance gets its own
 * Postgres database (e.g., `nomos_abc123`) and uses the default `public`
 * schema — no `search_path` juggling. This gives full catalog-level isolation
 * and makes per-customer `pg_dump`/restore and relocation trivial.
 *
 * Database names are validated against a strict regex to prevent SQL
 * injection — only `nomos_<lower_alphanumeric_or_underscore>` is allowed.
 * `CREATE DATABASE` / `DROP DATABASE` can't run inside a transaction and
 * can't be parameterized, so the validated identifier is interpolated and
 * the statement is sent in simple-query mode.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Allowed database name pattern. Must start with `nomos_` to make ownership obvious. */
const DB_NAME_PATTERN = /^nomos_[a-z0-9_]{1,48}$/;

/** Database names reserved for system use (never a customer). */
const RESERVED_DB_NAMES = new Set(["nomos_server", "nomos_admin", "nomos_system", "nomos_meta"]);

export function isValidDatabaseName(name: string): boolean {
  if (!DB_NAME_PATTERN.test(name)) return false;
  if (RESERVED_DB_NAMES.has(name)) return false;
  return true;
}

export function assertValidDatabaseName(name: string): void {
  if (!isValidDatabaseName(name)) {
    throw new Error(
      `Invalid database name "${name}". Must match /^nomos_[a-z0-9_]{1,48}$/ and not be reserved.`,
    );
  }
}

/**
 * Resolve the canonical schema.sql contents. Prefers an explicit override,
 * then on-disk schema.sql next to this file; throws if neither is available
 * (bundled callers must pass the content explicitly).
 */
function resolveSchemaSql(override?: string): string {
  if (override) return override;
  const schemaPath = path.join(__dirname, "schema.sql");
  try {
    return fs.readFileSync(schemaPath, "utf-8");
  } catch {
    throw new Error(
      "schema.sql not found on disk and no override provided. " +
        "Pass the schema content explicitly in bundled builds.",
    );
  }
}

/** Swap the database name in a Postgres connection URL. */
export function withDatabaseName(connectionUrl: string, dbName: string): string {
  assertValidDatabaseName(dbName);
  const u = new URL(connectionUrl);
  u.pathname = `/${dbName}`;
  return u.toString();
}

/**
 * Create a per-customer database. Idempotent (treats "already exists" as
 * success). Must be issued from a connection to a *different* database
 * (e.g., the admin/maintenance DB), in simple-query mode.
 */
export async function createDatabase(adminSql: postgres.Sql, dbName: string): Promise<void> {
  assertValidDatabaseName(dbName);
  const existing = await adminSql<{ one: number }[]>`
    SELECT 1 AS one FROM pg_database WHERE datname = ${dbName}
  `;
  if (existing.length > 0) return;
  try {
    await adminSql.unsafe(`CREATE DATABASE ${dbName}`).simple();
  } catch (err) {
    // 42P04 = duplicate_database (lost a creation race). Treat as success.
    if ((err as { code?: string }).code !== "42P04") throw err;
  }
}

/**
 * Drop a per-customer database and ALL its data. Destructive — GDPR-delete /
 * admin teardown only. WITH (FORCE) terminates active connections (PG13+).
 * Must be issued from a connection to a different database.
 */
export async function dropDatabase(adminSql: postgres.Sql, dbName: string): Promise<void> {
  assertValidDatabaseName(dbName);
  await adminSql.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).simple();
}

/**
 * Apply the canonical schema (extensions, tables, indexes) to the connected
 * database's `public` schema. Idempotent.
 */
export async function applySchema(sql: postgres.Sql, schemaSql?: string): Promise<void> {
  await sql.unsafe(resolveSchemaSql(schemaSql));
}

/**
 * Full provisioning for one customer: create the database from the admin
 * connection, then connect to it and apply the schema. Used by the admin
 * provisioning server.
 *
 * @param adminUrl A connection URL to an existing database (e.g. the admin
 *   server's own `nomos_server`, or the cluster's `postgres`). Used to issue
 *   CREATE DATABASE and as the template for the customer's connection URL.
 * @param dbName The customer database to create (`nomos_<id>`).
 * @param schemaSql Optional schema override (bundled builds pass it in).
 */
export async function provisionDatabase(
  adminUrl: string,
  dbName: string,
  schemaSql?: string,
): Promise<void> {
  assertValidDatabaseName(dbName);

  // 1. Create the database from the admin connection.
  const adminSql = postgres(adminUrl, { max: 1 });
  try {
    await createDatabase(adminSql, dbName);
  } finally {
    await adminSql.end();
  }

  // 2. Connect to the new database and apply the schema to its public schema.
  const customerSql = postgres(withDatabaseName(adminUrl, dbName), { max: 2 });
  try {
    await applySchema(customerSql, schemaSql);
  } finally {
    await customerSql.end();
  }
}
