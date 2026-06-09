/**
 * Platform identity linking.
 *
 * Links platform-specific user IDs (Slack, email, phone, Discord)
 * to unified contacts in the contacts table.
 *
 * Scoped by `userId` (the owner). The dedup key is (user_id, platform,
 * platform_user_id) so two members of one DB can each have an identity for the
 * same platform person without colliding.
 */

import { sql } from "kysely";
import { getKysely } from "../db/client.ts";
import { createContact, type ContactRow } from "./contacts.ts";

export interface ContactIdentityRow {
  id: string;
  user_id: string;
  contact_id: string;
  platform: string;
  platform_user_id: string;
  display_name: string | null;
  email: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
}

export async function linkIdentity(
  userId: string,
  contactId: string,
  platform: string,
  platformUserId: string,
  displayName?: string,
  email?: string,
  /** Extra platform profile data (avatar, handle, locale, raw...) -- merged on conflict. */
  metadata?: Record<string, unknown>,
): Promise<ContactIdentityRow> {
  const db = getKysely();
  const row = await db
    .insertInto("contact_identities")
    .values({
      user_id: userId,
      contact_id: contactId,
      platform,
      platform_user_id: platformUserId,
      display_name: displayName ?? null,
      email: email ?? null,
      // Pass the OBJECT (driver serializes to jsonb once); JSON.stringify would
      // double-encode into a jsonb string.
      ...(metadata ? { metadata: metadata as unknown as string } : {}),
    })
    .onConflict((oc) =>
      oc.columns(["user_id", "platform", "platform_user_id"]).doUpdateSet({
        contact_id: contactId,
        display_name: sql`COALESCE(EXCLUDED.display_name, contact_identities.display_name)`,
        email: sql`COALESCE(EXCLUDED.email, contact_identities.email)`,
        ...(metadata ? { metadata: sql`contact_identities.metadata || EXCLUDED.metadata` } : {}),
      }),
    )
    .returningAll()
    .executeTakeFirstOrThrow();
  return row as unknown as ContactIdentityRow;
}

export async function unlinkIdentity(userId: string, identityId: string): Promise<boolean> {
  const db = getKysely();
  const result = await db
    .deleteFrom("contact_identities")
    .where("user_id", "=", userId)
    .where("id", "=", identityId)
    .executeTakeFirst();
  return (result.numDeletedRows ?? 0n) > 0n;
}

/**
 * Resolve a platform user to a contact. Creates a new contact if none exists.
 */
export async function resolveContact(
  userId: string,
  platform: string,
  platformUserId: string,
  displayName?: string,
  email?: string,
  metadata?: Record<string, unknown>,
): Promise<{ contact: ContactRow; identity: ContactIdentityRow; created: boolean }> {
  const db = getKysely();

  // Check if identity already exists (for this owner)
  const existing = await db
    .selectFrom("contact_identities as ci")
    .innerJoin("contacts as c", "c.id", "ci.contact_id")
    .selectAll("ci")
    .select("c.display_name as contact_display_name")
    .where("ci.user_id", "=", userId)
    .where("ci.platform", "=", platform)
    .where("ci.platform_user_id", "=", platformUserId)
    .executeTakeFirst();

  if (existing) {
    const contact = await db
      .selectFrom("contacts")
      .selectAll()
      .where("user_id", "=", userId)
      .where("id", "=", existing.contact_id)
      .executeTakeFirstOrThrow();
    return {
      contact: contact as unknown as ContactRow,
      identity: existing as unknown as ContactIdentityRow,
      created: false,
    };
  }

  // Create new contact and link identity
  const name = displayName ?? platformUserId;
  const contact = await createContact(userId, { displayName: name });
  const identity = await linkIdentity(
    userId,
    contact.id,
    platform,
    platformUserId,
    displayName,
    email,
    metadata,
  );

  return { contact, identity, created: true };
}

/**
 * List all identities for a contact.
 */
export async function listIdentities(
  userId: string,
  contactId: string,
): Promise<ContactIdentityRow[]> {
  const db = getKysely();
  const rows = await db
    .selectFrom("contact_identities")
    .selectAll()
    .where("user_id", "=", userId)
    .where("contact_id", "=", contactId)
    .orderBy("platform")
    .orderBy("platform_user_id")
    .execute();
  return rows as unknown as ContactIdentityRow[];
}

/**
 * Find contact by any linked identity.
 */
export async function findContactByIdentity(
  userId: string,
  platform: string,
  platformUserId: string,
): Promise<ContactRow | null> {
  const db = getKysely();
  const row = await db
    .selectFrom("contacts as c")
    .innerJoin("contact_identities as ci", "ci.contact_id", "c.id")
    .selectAll("c")
    .where("ci.user_id", "=", userId)
    .where("ci.platform", "=", platform)
    .where("ci.platform_user_id", "=", platformUserId)
    .executeTakeFirst();
  return (row as unknown as ContactRow) ?? null;
}
