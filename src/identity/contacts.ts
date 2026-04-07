/**
 * Contact CRUD operations.
 *
 * A contact is a unified person across platforms (Slack, email, iMessage, etc.).
 * Each contact can have multiple platform identities linked to it.
 */

import { getDb } from "../db/client.ts";

export interface ContactRow {
  id: string;
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

export async function createContact(params: CreateContactParams): Promise<ContactRow> {
  const sql = getDb();
  const [row] = await sql<ContactRow[]>`
    INSERT INTO contacts (display_name, role, autonomy, notes)
    VALUES (${params.displayName}, ${params.role ?? null}, ${params.autonomy ?? "draft"}, ${params.notes ?? null})
    RETURNING *
  `;
  return row;
}

export async function getContact(id: string): Promise<ContactRow | null> {
  const sql = getDb();
  const rows = await sql<ContactRow[]>`SELECT * FROM contacts WHERE id = ${id}`;
  return rows[0] ?? null;
}

export async function listContacts(platform?: string): Promise<ContactRow[]> {
  const sql = getDb();
  if (platform) {
    return sql<ContactRow[]>`
      SELECT DISTINCT c.* FROM contacts c
      JOIN contact_identities ci ON ci.contact_id = c.id
      WHERE ci.platform = ${platform}
      ORDER BY c.display_name
    `;
  }
  return sql<ContactRow[]>`SELECT * FROM contacts ORDER BY display_name`;
}

export async function searchContacts(query: string): Promise<ContactRow[]> {
  const sql = getDb();
  const pattern = `%${query}%`;
  return sql<ContactRow[]>`
    SELECT * FROM contacts
    WHERE display_name ILIKE ${pattern}
       OR notes ILIKE ${pattern}
    ORDER BY display_name
    LIMIT 20
  `;
}

export async function updateContact(
  id: string,
  updates: Partial<
    Pick<ContactRow, "display_name" | "role" | "autonomy" | "notes" | "data_consent">
  >,
): Promise<ContactRow | null> {
  const sql = getDb();
  const rows = await sql<ContactRow[]>`
    UPDATE contacts SET
      display_name = COALESCE(${updates.display_name ?? null}, display_name),
      role = COALESCE(${updates.role ?? null}, role),
      autonomy = COALESCE(${updates.autonomy ?? null}, autonomy),
      notes = COALESCE(${updates.notes ?? null}, notes),
      data_consent = COALESCE(${updates.data_consent ?? null}, data_consent),
      updated_at = now()
    WHERE id = ${id}
    RETURNING *
  `;
  return rows[0] ?? null;
}

export async function deleteContact(id: string): Promise<boolean> {
  const sql = getDb();
  const result = await sql`DELETE FROM contacts WHERE id = ${id}`;
  return result.count > 0;
}

export async function mergeContacts(keepId: string, mergeId: string): Promise<ContactRow | null> {
  const sql = getDb();

  // Move all identities from mergeId to keepId
  await sql`
    UPDATE contact_identities SET contact_id = ${keepId}
    WHERE contact_id = ${mergeId}
  `;

  // Delete the merged contact
  await sql`DELETE FROM contacts WHERE id = ${mergeId}`;

  return getContact(keepId);
}
