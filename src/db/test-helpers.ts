/**
 * Test utilities for mocking Kysely queries.
 *
 * Usage in tests:
 * ```ts
 * const { db, addResult } = createMockDb();
 * vi.mock("./client.ts", () => ({ getKysely: () => db }));
 *
 * addResult([{ key: "a", value: 1 }]); // queue a result
 * const rows = await db.selectFrom("config").selectAll().execute();
 * // rows === [{ key: "a", value: 1 }]
 * ```
 */

import {
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type DatabaseConnection,
  type QueryResult,
} from "kysely";
import type { Database } from "./types.ts";

interface MockDb {
  db: Kysely<Database>;
  /** Queue a result that will be returned by the next query. */
  addResult: (rows: Record<string, unknown>[]) => void;
  /** Queue multiple results in order. */
  addResults: (results: Record<string, unknown>[][]) => void;
  /** Get all compiled queries that were executed. */
  getQueries: () => Array<{ sql: string; parameters: readonly unknown[] }>;
  /** Reset queued results and recorded queries. */
  reset: () => void;
}

export function createMockDb(): MockDb {
  const results: Record<string, unknown>[][] = [];
  const queries: Array<{ sql: string; parameters: readonly unknown[] }> = [];

  const connection: DatabaseConnection = {
    async executeQuery<R>(compiledQuery: {
      sql: string;
      parameters: readonly unknown[];
    }): Promise<QueryResult<R>> {
      queries.push({ sql: compiledQuery.sql, parameters: compiledQuery.parameters });
      const rows = (results.shift() ?? []) as R[];
      return {
        rows,
        numAffectedRows: BigInt(rows.length),
      };
    },
    streamQuery: async function* <R>(): AsyncIterableIterator<QueryResult<R>> {
      /* not used in tests */
    },
  };

  const db = new Kysely<Database>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => ({
        init: async () => {},
        acquireConnection: async () => connection,
        beginTransaction: async () => {},
        commitTransaction: async () => {},
        rollbackTransaction: async () => {},
        releaseConnection: async () => {},
        destroy: async () => {},
      }),
      createIntrospector: (db) => new PostgresIntrospector(db),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });

  return {
    db,
    addResult: (rows) => results.push(rows),
    addResults: (r) => results.push(...r),
    getQueries: () => queries,
    reset: () => {
      results.length = 0;
      queries.length = 0;
    },
  };
}
