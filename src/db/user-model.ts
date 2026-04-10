import { sql } from "kysely";
import { getKysely } from "./client.ts";

export interface UserModelEntry {
  id: string;
  category: string;
  key: string;
  value: unknown;
  sourceIds: string[];
  confidence: number;
  updatedAt: Date;
}

export async function upsertUserModel(
  entry: Omit<UserModelEntry, "id" | "updatedAt">,
): Promise<void> {
  const db = getKysely();
  const valueJson = JSON.stringify(entry.value);

  await db
    .insertInto("user_model")
    .values({
      category: entry.category,
      key: entry.key,
      value: valueJson,
      source_ids: entry.sourceIds,
      confidence: entry.confidence,
    })
    .onConflict((oc) =>
      oc.columns(["category", "key"]).doUpdateSet({
        value: sql`${valueJson}::jsonb`,
        source_ids: sql`(
          SELECT array_agg(DISTINCT s)
          FROM unnest(user_model.source_ids || ${entry.sourceIds}::text[]) AS s
        )`,
        confidence: entry.confidence,
        updated_at: sql`now()`,
      }),
    )
    .execute();
}

export async function getUserModel(category?: string): Promise<UserModelEntry[]> {
  const db = getKysely();

  let query = db
    .selectFrom("user_model")
    .select(["id", "category", "key", "value", "source_ids", "confidence", "updated_at"])
    .orderBy("confidence", "desc")
    .orderBy("updated_at", "desc");

  if (category) {
    query = query.where("category", "=", category);
  }

  const rows = await query.execute();
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
  const db = getKysely();
  const result = await db
    .deleteFrom("user_model")
    .where("category", "=", category)
    .where("key", "=", key)
    .executeTakeFirst();
  return (result.numDeletedRows ?? 0n) > 0n;
}
