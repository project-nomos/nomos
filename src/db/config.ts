import { getKysely } from "./client.ts";

export async function getConfigValue<T = unknown>(key: string): Promise<T | null> {
  const db = getKysely();
  const row = await db
    .selectFrom("config")
    .select("value")
    .where("key", "=", key)
    .executeTakeFirst();
  return (row?.value as T) ?? null;
}

export async function setConfigValue(key: string, value: unknown): Promise<void> {
  const db = getKysely();
  await db
    .insertInto("config")
    .values({ key, value: JSON.stringify(value), updated_at: new Date() })
    .onConflict((oc) =>
      oc.column("key").doUpdateSet({
        value: JSON.stringify(value),
        updated_at: new Date(),
      }),
    )
    .execute();
}

export async function deleteConfigValue(key: string): Promise<void> {
  const db = getKysely();
  await db.deleteFrom("config").where("key", "=", key).execute();
}

export async function listConfig(): Promise<Array<{ key: string; value: unknown }>> {
  const db = getKysely();
  return db.selectFrom("config").select(["key", "value"]).orderBy("key").execute();
}
