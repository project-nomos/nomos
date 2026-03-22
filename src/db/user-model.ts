import { getDb } from "./client.ts";

export interface UserModelEntry {
  id: string;
  category: string;
  key: string;
  value: unknown;
  sourceIds: string[];
  confidence: number;
  updatedAt: Date;
}

interface UserModelRow {
  id: string;
  category: string;
  key: string;
  value: unknown;
  source_ids: string[];
  confidence: number;
  updated_at: Date;
}

export async function upsertUserModel(
  entry: Omit<UserModelEntry, "id" | "updatedAt">,
): Promise<void> {
  const sql = getDb();
  const valueJson = JSON.stringify(entry.value);

  await sql`
    INSERT INTO user_model (category, key, value, source_ids, confidence)
    VALUES (
      ${entry.category},
      ${entry.key},
      ${valueJson}::jsonb,
      ${entry.sourceIds},
      ${entry.confidence}
    )
    ON CONFLICT (category, key) DO UPDATE SET
      value = ${valueJson}::jsonb,
      source_ids = (
        SELECT array_agg(DISTINCT s)
        FROM unnest(user_model.source_ids || ${entry.sourceIds}::text[]) AS s
      ),
      confidence = ${entry.confidence},
      updated_at = now()
  `;
}

export async function getUserModel(category?: string): Promise<UserModelEntry[]> {
  const sql = getDb();

  let rows: UserModelRow[];
  if (category) {
    rows = await sql<UserModelRow[]>`
      SELECT id, category, key, value, source_ids, confidence, updated_at
      FROM user_model
      WHERE category = ${category}
      ORDER BY confidence DESC, updated_at DESC
    `;
  } else {
    rows = await sql<UserModelRow[]>`
      SELECT id, category, key, value, source_ids, confidence, updated_at
      FROM user_model
      ORDER BY confidence DESC, updated_at DESC
    `;
  }

  return rows.map((row) => ({
    id: row.id,
    category: row.category,
    key: row.key,
    value: row.value,
    sourceIds: row.source_ids,
    confidence: row.confidence,
    updatedAt: row.updated_at,
  }));
}

export async function deleteUserModelEntry(category: string, key: string): Promise<boolean> {
  const sql = getDb();
  const result = await sql`
    DELETE FROM user_model WHERE category = ${category} AND key = ${key}
  `;
  return result.count > 0;
}
