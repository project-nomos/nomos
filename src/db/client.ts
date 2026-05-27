import { Kysely } from "kysely";
import { PostgresJSDialect } from "kysely-postgres-js";
import postgres from "postgres";
import type { Database } from "./types.ts";

let sqlInstance: postgres.Sql | null = null;
let kyselyInstance: Kysely<Database> | null = null;

/** Validate schema name to refuse anything that could be a SQL injection vector. */
function resolveSchema(): string | null {
  const raw = process.env.NOMOS_DB_SCHEMA;
  if (!raw) return null;
  if (!/^[a-z_][a-z0-9_]{0,62}$/i.test(raw)) {
    throw new Error(`Invalid NOMOS_DB_SCHEMA "${raw}"`);
  }
  return raw;
}

function getSqlInstance(): postgres.Sql {
  if (!sqlInstance) {
    // Default to local Postgres with `nomos` db (matches loadEnvConfig fallback).
    const url = process.env.DATABASE_URL ?? "postgresql://localhost:5432/nomos";
    const schema = resolveSchema();
    sqlInstance = postgres(url, {
      max: 10,
      idle_timeout: 30,
      connect_timeout: 10,
      onnotice: () => {}, // Suppress NOTICE messages from CREATE IF NOT EXISTS
      connection: schema
        ? {
            // Applied on every new physical connection in the pool, so every
            // query in this process is scoped to the customer's schema.
            search_path: `${schema}, public`,
          }
        : undefined,
    });
  }
  return sqlInstance;
}

export function getDb(): postgres.Sql {
  return getSqlInstance();
}

export function getKysely(): Kysely<Database> {
  if (!kyselyInstance) {
    kyselyInstance = new Kysely<Database>({
      dialect: new PostgresJSDialect({ postgres: getSqlInstance() }),
    });
  }
  return kyselyInstance;
}

export async function closeDb(): Promise<void> {
  if (kyselyInstance) {
    await kyselyInstance.destroy();
    kyselyInstance = null;
  }
  if (sqlInstance) {
    await sqlInstance.end();
    sqlInstance = null;
  }
}
