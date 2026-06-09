import { sql } from "kysely";
import { getKysely } from "./client.ts";

export interface UserModelEntry {
  id: string;
  userId: string;
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

  await db
    .insertInto("user_model")
    .values({
      user_id: entry.userId,
      category: entry.category,
      key: entry.key,
      // Pass the OBJECT (the driver serializes to jsonb once). JSON.stringify
      // here double-encodes into a jsonb *string*, so every consumer that casts
      // value to an object (calibration/reflection/personality-dna) reads
      // undefined fields.
      value: entry.value as unknown as string,
      source_ids: entry.sourceIds,
      confidence: entry.confidence,
    })
    .onConflict((oc) =>
      oc.columns(["user_id", "category", "key"]).doUpdateSet({
        value: entry.value as unknown as string,
        // COALESCE so merging two empty arrays yields '{}' rather than NULL:
        // array_agg over zero unnested rows returns NULL, which violates the
        // source_ids NOT NULL constraint.
        source_ids: sql`(
          SELECT COALESCE(array_agg(DISTINCT s), ARRAY[]::text[])
          FROM unnest(user_model.source_ids || ${entry.sourceIds}::text[]) AS s
        )`,
        confidence: entry.confidence,
        updated_at: sql`now()`,
      }),
    )
    .execute();
}

export async function getUserModel(userId: string, category?: string): Promise<UserModelEntry[]> {
  const db = getKysely();

  let query = db
    .selectFrom("user_model")
    .select(["id", "user_id", "category", "key", "value", "source_ids", "confidence", "updated_at"])
    .where("user_id", "=", userId)
    .orderBy("confidence", "desc")
    .orderBy("updated_at", "desc");

  if (category) {
    query = query.where("category", "=", category);
  }

  const rows = await query.execute();
  return rows.map((row) => ({
    id: row.id,
    userId: row.user_id,
    category: row.category,
    key: row.key,
    value: row.value,
    sourceIds: row.source_ids,
    confidence: row.confidence,
    updatedAt: row.updated_at,
  }));
}

export async function deleteUserModelEntry(
  userId: string,
  category: string,
  key: string,
): Promise<boolean> {
  const db = getKysely();
  const result = await db
    .deleteFrom("user_model")
    .where("user_id", "=", userId)
    .where("category", "=", category)
    .where("key", "=", key)
    .executeTakeFirst();
  return (result.numDeletedRows ?? 0n) > 0n;
}
