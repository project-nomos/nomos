/**
 * Platform identity linking.
 *
 * Links platform-specific user IDs (Slack, email, phone, Discord)
 * to unified contacts in the contacts table.
 */

import { getDb } from "../db/client.ts";
import { createContact, type ContactRow } from "./contacts.ts";

export interface ContactIdentityRow {
  id: string;
  contact_id: string;
  platform: string;
  platform_user_id: string;
  display_name: string | null;
  email: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
}

export async function linkIdentity(
  contactId: string,
  platform: string,
  platformUserId: string,
  displayName?: string,
  email?: string,
): Promise<ContactIdentityRow> {
  const sql = getDb();
  const [row] = await sql<ContactIdentityRow[]>`
    INSERT INTO contact_identities (contact_id, platform, platform_user_id, display_name, email)
    VALUES (${contactId}, ${platform}, ${platformUserId}, ${displayName ?? null}, ${email ?? null})
    ON CONFLICT (platform, platform_user_id)
    DO UPDATE SET
      contact_id = ${contactId},
      display_name = COALESCE(EXCLUDED.display_name, contact_identities.display_name),
      email = COALESCE(EXCLUDED.email, contact_identities.email)
    RETURNING *
  `;
  return row;
}

export async function unlinkIdentity(identityId: string): Promise<boolean> {
  const sql = getDb();
  const result = await sql`DELETE FROM contact_identities WHERE id = ${identityId}`;
  return result.count > 0;
}

/**
 * Resolve a platform user to a contact. Creates a new contact if none exists.
 */
export async function resolveContact(
  platform: string,
  platformUserId: string,
  displayName?: string,
  email?: string,
): Promise<{ contact: ContactRow; identity: ContactIdentityRow; created: boolean }> {
  const sql = getDb();

  // Check if identity already exists
  const existing = await sql<(ContactIdentityRow & { contact_display_name: string })[]>`
    SELECT ci.*, c.display_name AS contact_display_name
    FROM contact_identities ci
    JOIN contacts c ON c.id = ci.contact_id
    WHERE ci.platform = ${platform} AND ci.platform_user_id = ${platformUserId}
  `;

  if (existing.length > 0) {
    const identity = existing[0];
    const contact = await sql<
      ContactRow[]
    >`SELECT * FROM contacts WHERE id = ${identity.contact_id}`;
    return { contact: contact[0], identity, created: false };
  }

  // Create new contact and link identity
  const name = displayName ?? platformUserId;
  const contact = await createContact({ displayName: name });
  const identity = await linkIdentity(contact.id, platform, platformUserId, displayName, email);

  return { contact, identity, created: true };
}

/**
 * List all identities for a contact.
 */
export async function listIdentities(contactId: string): Promise<ContactIdentityRow[]> {
  const sql = getDb();
  return sql<ContactIdentityRow[]>`
    SELECT * FROM contact_identities
    WHERE contact_id = ${contactId}
    ORDER BY platform, platform_user_id
  `;
}

/**
 * Find contact by any linked identity.
 */
export async function findContactByIdentity(
  platform: string,
  platformUserId: string,
): Promise<ContactRow | null> {
  const sql = getDb();
  const rows = await sql<ContactRow[]>`
    SELECT c.* FROM contacts c
    JOIN contact_identities ci ON ci.contact_id = c.id
    WHERE ci.platform = ${platform} AND ci.platform_user_id = ${platformUserId}
  `;
  return rows[0] ?? null;
}
