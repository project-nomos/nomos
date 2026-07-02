/**
 * "What's slipping" detector (Bond gap plan, Phase 5).
 *
 * Bond's pitch is "tells you your highest leverage move"; the honest, grounded
 * version is a weekly pass that surfaces what is quietly falling through:
 *   - stalled items I owe (past deadline, or old + still unranked/unmoved),
 *   - things others owe me that are overdue and out of polite follow-ups,
 *   - goals with no recent linked activity,
 *   - people I owe a pile of things.
 *
 * It writes the report to an editable `slippage.md` vault note (durable, so the
 * user can read the latest review any time — the relationship-narrative pattern)
 * and returns the text for delivery to the owner's channel. Pure DB + vault
 * reads; no LLM, so it is cheap and deterministic.
 */

import { getActionItems } from "./commitment-tracker.ts";
import { listGoals } from "./goals.ts";
import { getKysely } from "../db/client.ts";
import { vaultWrite } from "../memory/vault.ts";

/** An item is "stalled" if past deadline, or older than this and still unranked. */
const STALE_DAYS = 14;
/** A goal is "stale" if untouched for longer than this. */
const STALE_GOAL_DAYS = 30;
/** Flag a person once they owe the user at least this many open items. */
const OWES_THRESHOLD = 3;

export interface SlippageReport {
  stalled: { id: string; description: string; overdueDays: number | null }[];
  overdueWaiting: { id: string; description: string; overdueDays: number | null }[];
  staleGoals: { title: string; staleDays: number }[];
  heavyContacts: { contact: string; count: number }[];
  /** Formatted Slack-mrkdwn block, or null when nothing is slipping. */
  text: string | null;
}

function daysAgo(d: Date | null): number | null {
  if (!d) return null;
  return Math.floor((Date.now() - d.getTime()) / 86_400_000);
}

/**
 * Compute the slippage report for one owner. Pure reads; safe to call anytime.
 */
export async function detectSlippage(userId: string): Promise<SlippageReport> {
  const [mine, theirs, goals] = await Promise.all([
    getActionItems(userId, { direction: "mine" }).catch(() => []),
    getActionItems(userId, { direction: "theirs" }).catch(() => []),
    listGoals(userId).catch(() => []),
  ]);

  const stalled = mine
    .filter((c) => {
      const overdue = c.deadline ? c.deadline.getTime() < Date.now() : false;
      const old = (daysAgo(c.created_at) ?? 0) >= STALE_DAYS && c.priority === null;
      return overdue || old;
    })
    .map((c) => ({
      id: c.id,
      description: c.description,
      overdueDays: c.deadline && c.deadline.getTime() < Date.now() ? daysAgo(c.deadline) : null,
    }));

  const overdueWaiting = theirs
    .filter((c) => c.deadline && c.deadline.getTime() < Date.now())
    .map((c) => ({ id: c.id, description: c.description, overdueDays: daysAgo(c.deadline) }));

  const staleGoals = goals
    .filter((g) => (daysAgo(g.updatedAt) ?? 0) >= STALE_GOAL_DAYS)
    .map((g) => ({ title: g.title, staleDays: daysAgo(g.updatedAt) ?? 0 }));

  // People I owe a pile of things (open 'mine' items grouped by contact).
  const heavyContacts = await detectHeavyContacts(userId);

  const text = formatSlippage({ stalled, overdueWaiting, staleGoals, heavyContacts });
  return { stalled, overdueWaiting, staleGoals, heavyContacts, text };
}

async function detectHeavyContacts(userId: string): Promise<{ contact: string; count: number }[]> {
  const rows = await getKysely()
    .selectFrom("commitments as k")
    .innerJoin("contacts as c", "c.id", "k.contact_id")
    .select(({ fn }) => ["c.display_name as contact", fn.countAll<number>().as("count")])
    .where("k.user_id", "=", userId)
    .where("k.status", "=", "pending")
    .where("k.direction", "=", "mine")
    .groupBy("c.display_name")
    .having((eb) => eb(eb.fn.countAll(), ">=", OWES_THRESHOLD))
    .execute()
    .catch(() => [] as { contact: string | null; count: number }[]);
  return rows
    .filter((r) => r.contact)
    .map((r) => ({ contact: r.contact as string, count: Number(r.count) }));
}

function formatSlippage(r: Omit<SlippageReport, "text">): string | null {
  const lines: string[] = [];
  if (r.stalled.length > 0) {
    lines.push("*Stalled (you owe):*");
    for (const s of r.stalled.slice(0, 6)) {
      const age = s.overdueDays != null ? ` — ${s.overdueDays}d overdue` : "";
      lines.push(`• ${s.description}${age}`);
    }
  }
  if (r.overdueWaiting.length > 0) {
    lines.push("*Overdue (owed to you):*");
    for (const s of r.overdueWaiting.slice(0, 6)) {
      const age = s.overdueDays != null ? ` — ${s.overdueDays}d overdue` : "";
      lines.push(`• ${s.description}${age}`);
    }
  }
  if (r.staleGoals.length > 0) {
    lines.push("*Goals with no recent movement:*");
    for (const g of r.staleGoals.slice(0, 5)) {
      lines.push(`• ${g.title} — quiet ${g.staleDays}d`);
    }
  }
  if (r.heavyContacts.length > 0) {
    lines.push("*You owe a lot to:*");
    for (const h of r.heavyContacts.slice(0, 5)) {
      lines.push(`• ${h.contact} — ${h.count} open`);
    }
  }
  if (lines.length === 0) return null;
  return `*What's slipping*\n${lines.join("\n")}`;
}

/**
 * Run the weekly slippage review for one owner: compute the report, persist it to
 * an editable `slippage.md` vault note, and return the deliverable text (or null
 * on a clean week). The vault note is the durable, user-readable record.
 */
export async function runSlippageForOwner(userId: string): Promise<string | null> {
  const report = await detectSlippage(userId);
  if (!report.text) return null;
  const body = `${report.text}\n\n_Reviewed weekly. Edit or clear anything here that's actually fine._`;
  await vaultWrite(userId, "slippage.md", body, { title: "What's slipping" }).catch(() => {});
  return report.text;
}
