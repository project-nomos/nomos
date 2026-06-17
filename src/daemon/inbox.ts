/**
 * Inbox overview -- the read model behind MobileApi.GetInbox.
 *
 * Two sections: (1) the agent's drafted replies awaiting the user's approval
 * (`draft_messages`: pending = "needs you", approved/sent = "handled"), and
 * (2) the CATE agent-to-agent inbound queue (`cate_inbound`, trust tiers + bonds).
 * Owner-scoped. Draft actions reuse ApproveDraft/RejectDraft; CATE actions reuse
 * ActOnInboxItem.
 */

import type { TenantContext } from "../auth/tenant-context.ts";
import { listPendingDrafts, type DraftRow } from "../db/drafts.ts";
import { getKysely } from "../db/client.ts";
import { sql } from "kysely";

export interface InboxDraft {
  id: string;
  recipient: string;
  preview: string;
  status: string; // pending | approved | sent
  platform: string;
  createdAt: string;
}
export interface InboxCate {
  id: string;
  fromLabel: string;
  trustTier: string;
  subject: string;
  bondAmount: string;
  createdAt: string;
}
export interface InboxOverview {
  drafts: InboxDraft[];
  cate: InboxCate[];
  blockedCount: number;
}

function draftRecipient(d: DraftRow): string {
  // context is a jsonb column; the driver may hand it back as an object or as a
  // raw JSON string -- handle both.
  let c: Record<string, unknown> = {};
  const raw: unknown = d.context;
  if (typeof raw === "string") {
    try {
      c = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      c = {};
    }
  } else if (raw && typeof raw === "object") {
    c = raw as Record<string, unknown>;
  }
  for (const key of ["contactName", "recipient", "to", "sender"]) {
    const v = c[key];
    if (typeof v === "string" && v.trim()) return v;
  }
  return d.platform.charAt(0).toUpperCase() + d.platform.slice(1);
}

function toInboxDraft(d: DraftRow): InboxDraft {
  return {
    id: d.id,
    recipient: draftRecipient(d),
    // Full draft text (the client truncates the list row; the edit sheet needs all of it).
    preview: d.content,
    status: d.status,
    platform: d.platform,
    createdAt: d.created_at.toISOString(),
  };
}

export async function getInboxOverview(ctx: TenantContext): Promise<InboxOverview> {
  const userId = ctx.userId;
  const db = getKysely();

  const pending = await listPendingDrafts(userId);
  const handled = (await db
    .selectFrom("draft_messages")
    .selectAll()
    .where("user_id", "=", userId)
    .where("status", "in", ["approved", "sent"])
    .orderBy("created_at", "desc")
    .limit(5)
    .execute()) as unknown as DraftRow[];

  const drafts = [...pending.map(toInboxDraft), ...handled.map(toInboxDraft)];

  let cate: InboxCate[] = [];
  let blockedCount = 0;
  try {
    const rows = await db.executeQuery(
      sql<{
        id: string;
        from_label: string | null;
        trust_tier: string;
        subject: string | null;
        bond_amount: string | null;
        created_at: Date;
      }>`
        SELECT id, from_label, trust_tier, subject, bond_amount::text AS bond_amount, created_at
        FROM cate_inbound WHERE user_id = ${userId} AND status = 'pending'
        ORDER BY created_at DESC LIMIT 50
      `.compile(db),
    );
    cate = rows.rows.map((r) => ({
      id: r.id,
      fromLabel: r.from_label ?? "",
      trustTier: r.trust_tier,
      subject: r.subject ?? "",
      bondAmount: r.bond_amount ?? "",
      createdAt: r.created_at.toISOString(),
    }));
    const blocked = await db.executeQuery(
      sql<{
        count: string;
      }>`SELECT COUNT(*)::text AS count FROM cate_inbound WHERE user_id = ${userId} AND status = 'denied'`.compile(
        db,
      ),
    );
    blockedCount = Number(blocked.rows[0]?.count ?? 0);
  } catch {
    // pre-Phase-5b: no cate_inbound table -> drafts only.
  }

  return { drafts, cate, blockedCount };
}
