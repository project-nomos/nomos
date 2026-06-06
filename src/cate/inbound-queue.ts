/**
 * CATE inbound queue writer.
 *
 * When a CATE envelope arrives (via the CATE server's onMessage hook), this
 * module:
 *   1. Classifies the sender's trust tier (verified | bonded | friend |
 *      blocked | unknown) based on `channel_allowlists`, `contacts`, and
 *      explicit allow/block lists.
 *   2. Inserts a row into `cate_inbound` so the mobile Inbox tab can show it.
 *   3. Fires an Expo push to all of the user's registered mobile devices.
 *
 * The mobile app then renders the queue; the user approves/denies/blocks
 * via `MobileApi.ActOnInboxItem`, which updates the row's status.
 */

import { sql } from "kysely";
import { getKysely } from "../db/client.ts";
import { notifyUser } from "../daemon/push-notifications.ts";
import { systemTenant } from "../auth/tenant-context.ts";
import { createLogger } from "../lib/logger.ts";

const log = createLogger("cate-inbound");

export type TrustTier = "verified" | "bonded" | "friend" | "blocked" | "unknown";

export interface InboundEnvelopeFields {
  /** Sender's DID (e.g., did:key:z6Mki…). */
  fromDid: string;
  /** Human-friendly label for the sender, if known. */
  fromLabel?: string;
  /** Free-text subject for the inbox row. */
  subject?: string;
  /** Plain-text body preview. */
  body?: string;
  /** Bond amount in stable units (string to preserve precision). */
  bondAmount?: string;
  /** Bond currency (e.g., USD). */
  bondCurrency?: string;
  /** Full raw CATE envelope JSON. */
  envelope: Record<string, unknown>;
  /** Optional user_id override; defaults to system tenant. */
  userId?: string;
}

/**
 * Classify a sender's trust tier. v1 implementation: looks up the DID in
 * known contacts and channel_allowlists. Returns "unknown" when no
 * positive signal is found.
 *
 * Bonded senders (those who staked a bond with their envelope) get
 * "bonded" regardless of allowlist state — the bond is the trust signal.
 */
async function classifyTrustTier(fields: InboundEnvelopeFields): Promise<TrustTier> {
  if (fields.bondAmount && Number(fields.bondAmount) > 0) {
    return "bonded";
  }

  // Contacts the user has explicitly added as friends. The contact_identities
  // table maps platform user IDs to contacts; we treat the CATE DID as one
  // such platform identifier with platform='cate' if present.
  try {
    const db = getKysely();
    const r = await db.executeQuery(
      sql<{ id: string }>`
        SELECT contact_id AS id
        FROM contact_identities
        WHERE platform = 'cate' AND platform_user_id = ${fields.fromDid}
        LIMIT 1
      `.compile(db),
    );
    if (r.rows.length > 0) return "friend";
  } catch {
    // Table may be missing or schema mismatch — fall through to unknown.
  }

  // No positive trust signal → unknown.
  return "unknown";
}

/**
 * Append a new CATE envelope to the inbound queue and notify the user.
 *
 * Returns the new row id, or null on duplicate / permanent failure.
 */
export async function enqueueInbound(fields: InboundEnvelopeFields): Promise<string | null> {
  const tier = await classifyTrustTier(fields);
  const userId = fields.userId ?? systemTenant().userId;

  // Block tier → drop without enqueueing.
  if (tier === "blocked") {
    log.debug({ fromDid: fields.fromDid }, "Blocked sender — dropping envelope");
    return null;
  }

  const db = getKysely();
  let id: string | null = null;
  try {
    const row = await db
      .insertInto("cate_inbound")
      .values({
        user_id: userId,
        from_did: fields.fromDid,
        from_label: fields.fromLabel ?? null,
        trust_tier: tier,
        subject: fields.subject ?? null,
        body: fields.body ?? null,
        envelope: JSON.stringify(fields.envelope),
        bond_amount: fields.bondAmount ?? null,
        bond_currency: fields.bondCurrency ?? null,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    id = row.id;
  } catch (err) {
    log.error({ err, fromDid: fields.fromDid }, "Failed to enqueue inbound envelope");
    return null;
  }

  // Fire push notification (fire-and-forget).
  notifyUser(userId, {
    title: tierTitle(tier, fields.fromLabel ?? fields.fromDid),
    body: fields.subject ?? "New agent request",
    data: { inboxId: id, kind: "cate_inbound", trustTier: tier },
  }).catch((err) => log.warn({ err }, "Push fan-out failed"));

  return id;
}

function tierTitle(tier: TrustTier, sender: string): string {
  switch (tier) {
    case "verified":
      return `Verified: ${sender}`;
    case "bonded":
      return `Sponsored: ${sender}`;
    case "friend":
      return `Friend: ${sender}`;
    default:
      return `New request from ${sender}`;
  }
}

/**
 * Look up the current count of pending items for the badge.
 */
export async function pendingCount(userId: string): Promise<number> {
  const db = getKysely();
  const r = await db
    .selectFrom("cate_inbound")
    .select(({ fn }) => fn.countAll<number>().as("c"))
    .where("user_id", "=", userId)
    .where("status", "=", "pending")
    .executeTakeFirst();
  return Number(r?.c ?? 0);
}
