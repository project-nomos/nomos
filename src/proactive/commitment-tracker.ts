/**
 * Commitment tracker.
 *
 * Extracts commitments (promises, deadlines, follow-ups) from conversations
 * via a forked agent. Stores them in the commitments table and triggers
 * reminders via cron.
 */

import { sql } from "kysely";
import { z } from "zod";
import { getKysely } from "../db/client.ts";
import { runReasoningFork } from "../sdk/reasoning-fork.ts";
import { searchContacts } from "../identity/contacts.ts";

/** Commitment direction: I owe someone ('mine') vs someone owes me ('theirs'). */
export type CommitmentDirection = "mine" | "theirs";
export type CommitmentPriority = "p0" | "p1" | "p2" | "p3";
export type CommitmentStatus = "pending" | "completed" | "expired" | "cancelled" | "delegated";

export interface CommitmentRow {
  id: string;
  user_id: string;
  contact_id: string | null;
  description: string;
  source_msg: string | null;
  deadline: Date | null;
  status: CommitmentStatus;
  reminded: boolean;
  direction: CommitmentDirection;
  priority: CommitmentPriority | null;
  rank_reason: string | null;
  source: string;
  source_ref: string | null;
  delegated_to: string | null;
  next_follow_up_at: Date | null;
  follow_up_count: number;
  created_at: Date;
  updated_at: Date;
}

export interface ExtractedCommitment {
  description: string;
  deadline: string | null;
  contact: string | null;
  /** 'mine' = the user owes this; 'theirs' = someone owes the user. */
  direction?: CommitmentDirection;
}

/** Extra provenance for a stored commitment (which surface, which thread). */
export interface CommitmentSource {
  /** chat | email | imessage | slack | whatsapp | telegram | discord | meeting | manual */
  source?: string;
  /** Origin thread/message/event id so a follow-up can reply on the same thread. */
  sourceRef?: string;
}

const ExtractedCommitmentsSchema = z.object({
  commitments: z
    .array(
      z.object({
        description: z.string(),
        // nullable + default(null) yields `string | null` WITHOUT a .transform()
        // (transforms can't be represented as JSON Schema for the SDK outputFormat).
        deadline: z.string().nullable().default(null),
        contact: z.string().nullable().default(null),
        // `.catch` keeps one off-list value from failing the whole batch.
        direction: z.enum(["mine", "theirs"]).catch("mine").default("mine"),
      }),
    )
    .default([]),
});

const COMMITMENT_EXTRACTION_INSTRUCTIONS = `Analyze the conversation and extract any commitments, promises, or follow-up items — in BOTH directions.

A commitment is something someone owes:
- direction "mine": the USER promised to do it, needs to follow up on it, or was asked to do it.
  Examples: "I'll send that report by Friday", "Let me check and get back to you", "I need to review the PR"
- direction "theirs": someone else owes the USER something (a reply, a deliverable, an approval).
  Examples: "Can you get me the numbers by Monday?" (from the user to X), "waiting on Sarah for sign-off", "X said they'd send the contract"

Return a JSON object with a "commitments" array. Each commitment has:
- "description": what needs to be done (phrase it as the outstanding item)
- "deadline": ISO date string if mentioned, null otherwise
- "contact": the other party's name, null if unclear
- "direction": "mine" or "theirs" (default "mine" when genuinely ambiguous)

Return an empty "commitments" array if no commitments found. Return ONLY the JSON object.`;

/**
 * Extract commitments from a conversation exchange.
 */
export async function extractCommitments(
  userMessage: string,
  agentResponse: string,
): Promise<ExtractedCommitment[]> {
  const input = `USER: ${userMessage}
RESPONSE: ${agentResponse}`;

  const { data } = await runReasoningFork({
    instructions: COMMITMENT_EXTRACTION_INSTRUCTIONS,
    input,
    schema: ExtractedCommitmentsSchema,
    maxTurns: 1,
    label: "commitment-extraction",
  });

  return data?.commitments ?? [];
}

/**
 * Store extracted commitments in the database.
 *
 * `provenance` records which surface captured the item and a pointer back to the
 * origin thread (so a Phase-3 follow-up can be drafted on the same channel). For
 * 'theirs' items we seed `next_follow_up_at` to the deadline (or +1 day when no
 * deadline is given) so the polite follow-up engine has something to act on.
 */
export async function storeCommitments(
  userId: string,
  commitments: ExtractedCommitment[],
  sourceMsg?: string,
  provenance?: CommitmentSource,
): Promise<CommitmentRow[]> {
  if (commitments.length === 0) return [];

  const db = getKysely();
  const stored: CommitmentRow[] = [];

  for (const c of commitments) {
    // Link the commitment to the person it's about: resolve the extracted contact
    // name to a contact_id (best-effort -- first ilike match). Null when unnamed
    // or no match; a lookup failure must never block storing the commitment.
    let contactId: string | null = null;
    if (c.contact?.trim()) {
      const matches = await searchContacts(userId, c.contact.trim()).catch(() => []);
      contactId = matches[0]?.id ?? null;
    }
    const direction: CommitmentDirection = c.direction ?? "mine";
    const deadline = c.deadline ? new Date(c.deadline) : null;
    // Seed the first follow-up moment for items others owe the user.
    const nextFollowUp =
      direction === "theirs" ? (deadline ?? new Date(Date.now() + 24 * 60 * 60 * 1000)) : null;
    const row = await db
      .insertInto("commitments")
      .values({
        user_id: userId,
        contact_id: contactId,
        description: c.description,
        source_msg: sourceMsg ?? null,
        deadline,
        direction,
        source: provenance?.source ?? "chat",
        source_ref: provenance?.sourceRef ?? null,
        next_follow_up_at: nextFollowUp,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    stored.push(row as unknown as CommitmentRow);
  }

  return stored;
}

/**
 * Get pending commitments, optionally filtered by upcoming deadlines.
 */
export async function getPendingCommitments(
  userId: string,
  daysAhead?: number,
): Promise<CommitmentRow[]> {
  const db = getKysely();

  let query = db
    .selectFrom("commitments")
    .selectAll()
    .where("user_id", "=", userId)
    .where("status", "=", "pending");

  if (daysAhead !== undefined) {
    query = query
      .where("deadline", "is not", null)
      .where("deadline", "<=", sql<Date>`now() + interval '1 day' * ${daysAhead}`)
      .orderBy("deadline", "asc");
  } else {
    query = query.orderBy(sql`deadline ASC NULLS LAST`).orderBy("created_at", "desc");
  }

  return query.execute() as unknown as Promise<CommitmentRow[]>;
}

/**
 * Mark a commitment as completed.
 */
export async function completeCommitment(userId: string, id: string): Promise<void> {
  const db = getKysely();
  await db
    .updateTable("commitments")
    .set({ status: "completed", updated_at: sql`now()` })
    .where("user_id", "=", userId)
    .where("id", "=", id)
    .execute();
}

/**
 * Get commitments due for reminders (deadline within 24h, not yet reminded).
 */
export async function getCommitmentsForReminder(userId: string): Promise<CommitmentRow[]> {
  const db = getKysely();
  const rows = await db
    .selectFrom("commitments")
    .selectAll()
    .where("user_id", "=", userId)
    .where("status", "=", "pending")
    .where("reminded", "=", false)
    .where("deadline", "is not", null)
    .where("deadline", "<=", sql<Date>`now() + interval '24 hours'`)
    .orderBy("deadline", "asc")
    .execute();
  return rows as unknown as CommitmentRow[];
}

/**
 * Mark commitments as reminded.
 */
export async function markReminded(userId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const db = getKysely();
  await db
    .updateTable("commitments")
    .set({ reminded: true, updated_at: sql`now()` })
    .where("user_id", "=", userId)
    .where("id", "in", ids)
    .execute();
}

/**
 * Expire overdue commitments (past deadline by more than 7 days).
 */
export async function expireOverdueCommitments(userId: string): Promise<number> {
  const db = getKysely();
  const result = await db
    .updateTable("commitments")
    .set({ status: "expired", updated_at: sql`now()` })
    .where("user_id", "=", userId)
    .where("status", "=", "pending")
    .where("deadline", "is not", null)
    .where("deadline", "<", sql<Date>`now() - interval '7 days'`)
    .executeTakeFirst();
  return Number(result.numUpdatedRows ?? 0n);
}

// ── Action-item backbone (Bond gap plan) ────────────────────────────────────

export interface ActionItemQuery {
  /** Filter to one direction; omit for both. */
  direction?: CommitmentDirection;
  /** Status filter; defaults to 'pending'. */
  status?: CommitmentStatus;
  limit?: number;
}

/**
 * The ranked action list: pending items, priority-first (p0..p3, unranked last),
 * then by deadline (soonest first, no-deadline last), then newest. This is the
 * single read the Today brief + morning briefing + the todo_list tool render.
 */
export async function getActionItems(
  userId: string,
  q: ActionItemQuery = {},
): Promise<CommitmentRow[]> {
  const db = getKysely();
  let query = db
    .selectFrom("commitments")
    .selectAll()
    .where("user_id", "=", userId)
    .where("status", "=", q.status ?? "pending");
  if (q.direction) query = query.where("direction", "=", q.direction);
  query = query
    // priority p0<p1<p2<p3, NULL (unranked) last
    .orderBy(sql`priority ASC NULLS LAST`)
    .orderBy(sql`deadline ASC NULLS LAST`)
    .orderBy("created_at", "desc");
  if (q.limit !== undefined) query = query.limit(q.limit);
  return query.execute() as unknown as Promise<CommitmentRow[]>;
}

/** The "waiting on others" lane: things someone else owes the user. */
export async function getWaitingOn(userId: string): Promise<CommitmentRow[]> {
  return getActionItems(userId, { direction: "theirs" });
}

/**
 * Add an action item directly (the manual / tool-driven path, no extraction).
 * Returns the stored row.
 */
export async function addActionItem(
  userId: string,
  item: {
    description: string;
    deadline?: Date | null;
    contact?: string | null;
    direction?: CommitmentDirection;
    source?: string;
    sourceRef?: string;
  },
): Promise<CommitmentRow> {
  const [row] = await storeCommitments(
    userId,
    [
      {
        description: item.description,
        deadline: item.deadline ? item.deadline.toISOString() : null,
        contact: item.contact ?? null,
        direction: item.direction ?? "mine",
      },
    ],
    undefined,
    { source: item.source ?? "manual", sourceRef: item.sourceRef },
  );
  return row!;
}

/** Snooze an item's deadline (and reset its reminder flag) to a new time. */
export async function snoozeCommitment(userId: string, id: string, until: Date): Promise<void> {
  const db = getKysely();
  await db
    .updateTable("commitments")
    .set({ deadline: until, reminded: false, updated_at: sql`now()` })
    .where("user_id", "=", userId)
    .where("id", "=", id)
    .execute();
}

/** Mark an item delegated (handed off to a person or to the agent itself). */
export async function delegateCommitment(userId: string, id: string, to: string): Promise<void> {
  const db = getKysely();
  await db
    .updateTable("commitments")
    .set({ status: "delegated", delegated_to: to, updated_at: sql`now()` })
    .where("user_id", "=", userId)
    .where("id", "=", id)
    .execute();
}

/** Drop an item the user no longer intends to do (soft-cancel). */
export async function dropCommitment(userId: string, id: string): Promise<void> {
  const db = getKysely();
  await db
    .updateTable("commitments")
    .set({ status: "cancelled", updated_at: sql`now()` })
    .where("user_id", "=", userId)
    .where("id", "=", id)
    .execute();
}

// ── Ranking (Phase 2) ───────────────────────────────────────────────────────

/** Write a computed priority + reason onto an item. */
export async function setPriority(
  userId: string,
  id: string,
  priority: CommitmentPriority,
  reason: string,
): Promise<void> {
  const db = getKysely();
  await db
    .updateTable("commitments")
    .set({ priority, rank_reason: reason, updated_at: sql`now()` })
    .where("user_id", "=", userId)
    .where("id", "=", id)
    .execute();
}

// ── Follow-up engine (Phase 3) ──────────────────────────────────────────────

/** Backoff schedule for polite nudges on 'theirs' items: due+1d, +3d, +7d. */
export const FOLLOW_UP_BACKOFF_DAYS = [1, 3, 7] as const;
export const MAX_FOLLOW_UPS = FOLLOW_UP_BACKOFF_DAYS.length;

/**
 * Items others owe the user whose next follow-up moment has arrived and that
 * have not exhausted the backoff schedule. Drives the follow-up drafter.
 */
export async function getCommitmentsDueForFollowUp(userId: string): Promise<CommitmentRow[]> {
  const db = getKysely();
  const rows = await db
    .selectFrom("commitments")
    .selectAll()
    .where("user_id", "=", userId)
    .where("direction", "=", "theirs")
    .where("status", "=", "pending")
    .where("next_follow_up_at", "is not", null)
    .where("next_follow_up_at", "<=", sql<Date>`now()`)
    .where("follow_up_count", "<", MAX_FOLLOW_UPS)
    .orderBy("next_follow_up_at", "asc")
    .execute();
  return rows as unknown as CommitmentRow[];
}

/**
 * Record that a follow-up was drafted for an item: bump the counter and schedule
 * the next nudge per the backoff schedule (or clear it once exhausted).
 */
export async function recordFollowUp(userId: string, id: string): Promise<void> {
  const db = getKysely();
  const row = await db
    .selectFrom("commitments")
    .select(["follow_up_count"])
    .where("user_id", "=", userId)
    .where("id", "=", id)
    .executeTakeFirst();
  const nextCount = Number(row?.follow_up_count ?? 0) + 1;
  const nextDays = FOLLOW_UP_BACKOFF_DAYS[nextCount];
  const nextAt = nextDays !== undefined ? sql<Date>`now() + interval '1 day' * ${nextDays}` : null;
  await db
    .updateTable("commitments")
    .set({
      follow_up_count: nextCount,
      next_follow_up_at: nextAt,
      updated_at: sql`now()`,
    })
    .where("user_id", "=", userId)
    .where("id", "=", id)
    .execute();
}
