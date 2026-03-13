import { getDb } from "./client.ts";

export async function getConfigValue<T = unknown>(key: string): Promise<T | null> {
  const sql = getDb();
  const [row] = await sql<[{ value: T }?]>`
    SELECT value FROM config WHERE key = ${key}
  `;
  return row?.value ?? null;
}

export async function setConfigValue(key: string, value: unknown): Promise<void> {
  const sql = getDb();
  await sql`
    INSERT INTO config (key, value, updated_at)
    VALUES (${key}, ${JSON.stringify(value)}, now())
    ON CONFLICT (key) DO UPDATE SET
      value = ${JSON.stringify(value)},
      updated_at = now()
  `;
}

export async function deleteConfigValue(key: string): Promise<void> {
  const sql = getDb();
  await sql`DELETE FROM config WHERE key = ${key}`;
}

export async function listConfig(): Promise<Array<{ key: string; value: unknown }>> {
  const sql = getDb();
  return sql<Array<{ key: string; value: unknown }>>`
    SELECT key, value FROM config ORDER BY key
  `;
}
