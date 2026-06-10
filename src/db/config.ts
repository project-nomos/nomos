import { sql } from "kysely";
import { getKysely } from "./client.ts";

export async function getConfigValue<T = unknown>(key: string): Promise<T | null> {
  const db = getKysely();
  const row = await db
    .selectFrom("config")
    .select("value")
    .where("key", "=", key)
    .executeTakeFirst();
  let v = row?.value ?? null;
  // Back-compat: older writes JSON.stringify'd into the jsonb column, so the row
  // is a json *string* that itself contains JSON. Unwrap it. A legitimate plain
  // string value (not starting with {/[/") is returned as-is.
  if (typeof v === "string") {
    const t = v.trimStart();
    if (t.startsWith("{") || t.startsWith("[") || t.startsWith('"')) {
      try {
        v = JSON.parse(v);
      } catch {
        /* keep the plain string */
      }
    }
  }
  return (v as T) ?? null;
}

export async function setConfigValue(key: string, value: unknown): Promise<void> {
  const db = getKysely();
  // Serialize to JSON text, then cast ::text::jsonb. The ::text step is load-
  // bearing: it forces postgres-js to bind the param as text instead of inferring
  // a type. A bare ::jsonb makes the driver JSON-encode the string again (storing
  // jsonb "false" instead of boolean false), and a raw JS boolean infers as bool
  // OID which Postgres refuses to implicitly cast to jsonb. ::text::jsonb is
  // uniform: 'false'->boolean, '20'->number, '"1h"'->string, '{...}'->object.
  // Single encode, so getConfigValue reads it back natively (its unwrap still
  // covers any legacy double-encoded rows).
  const jsonbText = JSON.stringify(value ?? null);
  const jsonbValue = sql<string>`${jsonbText}::text::jsonb`;
  await db
    .insertInto("config")
    .values({ key, value: jsonbValue, updated_at: new Date() })
    .onConflict((oc) => oc.column("key").doUpdateSet({ value: jsonbValue, updated_at: new Date() }))
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
