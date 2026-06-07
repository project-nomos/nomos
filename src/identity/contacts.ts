/**
 * Contact CRUD operations.
 *
 * A contact is a unified person across platforms (Slack, email, iMessage, etc.).
 * Each contact can have multiple platform identities linked to it.
 *
 * Every operation is scoped by `userId` (the owner) as zero-trust defense-in-depth
 * on top of database-per-customer: in a multi-user DB one member must never read,
 * update, delete, or MERGE another member's contacts.
 */

import { sql } from "kysely";
import { getKysely } from "../db/client.ts";

export interface ContactRow {
  id: string;
  user_id: string;
  display_name: string;
  role: string | null;
  relationship: Record<string, unknown>;
  autonomy: "auto" | "draft" | "silent";
  data_consent: "inferred" | "explicit" | "withdrawn";
  notes: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface CreateContactParams {
  displayName: string;
  role?: string;
  autonomy?: "auto" | "draft" | "silent";
  notes?: string;
}

export async function createContact(
  userId: string,
  params: CreateContactParams,
): Promise<ContactRow> {
  const db = getKysely();
  const row = await db
    .insertInto("contacts")
    .values({
      user_id: userId,
      display_name: params.displayName,
      role: params.role ?? null,
      autonomy: params.autonomy ?? "draft",
      notes: params.notes ?? null,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  return row as unknown as ContactRow;
}

export async function getContact(userId: string, id: string): Promise<ContactRow | null> {
  const db = getKysely();
  const row = await db
    .selectFrom("contacts")
    .selectAll()
    .where("user_id", "=", userId)
    .where("id", "=", id)
    .executeTakeFirst();
  return (row as unknown as ContactRow) ?? null;
}

export async function listContacts(userId: string, platform?: string): Promise<ContactRow[]> {
  const db = getKysely();
  if (platform) {
    const rows = await db
      .selectFrom("contacts as c")
      .distinctOn("c.id")
      .selectAll("c")
      .innerJoin("contact_identities as ci", "ci.contact_id", "c.id")
      .where("c.user_id", "=", userId)
      .where("ci.platform", "=", platform)
      .orderBy("c.id")
      .execute();
    // Re-sort by display_name after distinctOn (which requires ordering by distinct columns first)
    return (rows as unknown as ContactRow[]).sort((a, b) =>
      a.display_name.localeCompare(b.display_name),
    );
  }
  const rows = await db
    .selectFrom("contacts")
    .selectAll()
    .where("user_id", "=", userId)
    .orderBy("display_name")
    .execute();
  return rows as unknown as ContactRow[];
}

export async function searchContacts(userId: string, query: string): Promise<ContactRow[]> {
  const db = getKysely();
  const pattern = `%${query}%`;
  const rows = await db
    .selectFrom("contacts")
    .selectAll()
    .where("user_id", "=", userId)
    .where((eb) => eb.or([eb("display_name", "ilike", pattern), eb("notes", "ilike", pattern)]))
    .orderBy("display_name")
    .limit(20)
    .execute();
  return rows as unknown as ContactRow[];
}

export async function updateContact(
  userId: string,
  id: string,
  updates: Partial<
    Pick<ContactRow, "display_name" | "role" | "autonomy" | "notes" | "data_consent">
  >,
): Promise<ContactRow | null> {
  const db = getKysely();
  const row = await db
    .updateTable("contacts")
    .set({
      display_name: sql`COALESCE(${updates.display_name ?? null}, display_name)`,
      role: sql`COALESCE(${updates.role ?? null}, role)`,
      autonomy: sql`COALESCE(${updates.autonomy ?? null}, autonomy)`,
      notes: sql`COALESCE(${updates.notes ?? null}, notes)`,
      data_consent: sql`COALESCE(${updates.data_consent ?? null}, data_consent)`,
      updated_at: sql`now()`,
    })
    .where("user_id", "=", userId)
    .where("id", "=", id)
    .returningAll()
    .executeTakeFirst();
  return (row as unknown as ContactRow) ?? null;
}

export async function deleteContact(userId: string, id: string): Promise<boolean> {
  const db = getKysely();
  const result = await db
    .deleteFrom("contacts")
    .where("user_id", "=", userId)
    .where("id", "=", id)
    .executeTakeFirst();
  return (result.numDeletedRows ?? 0n) > 0n;
}

export async function mergeContacts(
  userId: string,
  keepId: string,
  mergeId: string,
): Promise<ContactRow | null> {
  const db = getKysely();

  // Move all identities from mergeId to keepId, scoped to the owner so a merge
  // can never reach across users. (The auto-linker only ever proposes merges
  // within one user's contacts; this enforces it at the data layer.)
  await db
    .updateTable("contact_identities")
    .set({ contact_id: keepId })
    .where("user_id", "=", userId)
    .where("contact_id", "=", mergeId)
    .execute();

  // Delete the merged contact (owner-scoped).
  await db.deleteFrom("contacts").where("user_id", "=", userId).where("id", "=", mergeId).execute();

  return getContact(userId, keepId);
}
