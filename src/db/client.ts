import { Kysely } from "kysely";
import { PostgresJSDialect } from "kysely-postgres-js";
import postgres from "postgres";
import type { Database } from "./types.ts";

let sqlInstance: postgres.Sql | null = null;
let kyselyInstance: Kysely<Database> | null = null;

function getSqlInstance(): postgres.Sql {
  if (!sqlInstance) {
    // Default to local Postgres with `nomos` db (matches loadEnvConfig fallback).
    const url = process.env.DATABASE_URL ?? "postgresql://localhost:5432/nomos";
    sqlInstance = postgres(url, {
      max: 10,
      idle_timeout: 30,
      connect_timeout: 10,
      onnotice: () => {}, // Suppress NOTICE messages from CREATE IF NOT EXISTS
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
