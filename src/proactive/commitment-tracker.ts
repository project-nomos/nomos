/**
 * Commitment tracker.
 *
 * Extracts commitments (promises, deadlines, follow-ups) from conversations
 * via a forked agent. Stores them in the commitments table and triggers
 * reminders via cron.
 */

import { sql } from "kysely";
import { getKysely } from "../db/client.ts";
import { runForkedAgent } from "../sdk/forked-agent.ts";

export interface CommitmentRow {
  id: string;
  contact_id: string | null;
  description: string;
  source_msg: string | null;
  deadline: Date | null;
  status: "pending" | "completed" | "expired" | "cancelled";
  reminded: boolean;
  created_at: Date;
  updated_at: Date;
}

interface ExtractedCommitment {
  description: string;
  deadline: string | null;
  contact: string | null;
}

/**
 * Extract commitments from a conversation exchange.
 */
export async function extractCommitments(
  userMessage: string,
  agentResponse: string,
): Promise<ExtractedCommitment[]> {
  const prompt = `Analyze this conversation and extract any commitments, promises, or follow-up items.

USER: ${userMessage}
RESPONSE: ${agentResponse}

A commitment is something the user promised to do, needs to follow up on, or was asked to do.
Examples: "I'll send that report by Friday", "Let me check and get back to you", "I need to review the PR"

Return a JSON array of commitments. Each has:
- "description": what needs to be done
- "deadline": ISO date string if mentioned, null otherwise
- "contact": who it's for, null if unclear

Return [] if no commitments found. Return ONLY the JSON array.`;

  const result = await runForkedAgent({
    prompt,
    label: "commitment-extraction",
  });

  try {
    const jsonMatch = result.text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];
    return JSON.parse(jsonMatch[0]) as ExtractedCommitment[];
  } catch {
    return [];
  }
}

/**
 * Store extracted commitments in the database.
 */
export async function storeCommitments(
  commitments: ExtractedCommitment[],
  sourceMsg?: string,
): Promise<CommitmentRow[]> {
  if (commitments.length === 0) return [];

  const db = getKysely();
  const stored: CommitmentRow[] = [];

  for (const c of commitments) {
    const row = await db
      .insertInto("commitments")
      .values({
        description: c.description,
        source_msg: sourceMsg ?? null,
        deadline: c.deadline ? new Date(c.deadline) : null,
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
export async function getPendingCommitments(daysAhead?: number): Promise<CommitmentRow[]> {
  const db = getKysely();

  let query = db.selectFrom("commitments").selectAll().where("status", "=", "pending");

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
export async function completeCommitment(id: string): Promise<void> {
  const db = getKysely();
  await db
    .updateTable("commitments")
    .set({ status: "completed", updated_at: sql`now()` })
    .where("id", "=", id)
    .execute();
}

/**
 * Get commitments due for reminders (deadline within 24h, not yet reminded).
 */
export async function getCommitmentsForReminder(): Promise<CommitmentRow[]> {
  const db = getKysely();
  const rows = await db
    .selectFrom("commitments")
    .selectAll()
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
export async function markReminded(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const db = getKysely();
  await db
    .updateTable("commitments")
    .set({ reminded: true, updated_at: sql`now()` })
    .where("id", "in", ids)
    .execute();
}

/**
 * Expire overdue commitments (past deadline by more than 7 days).
 */
export async function expireOverdueCommitments(): Promise<number> {
  const db = getKysely();
  const result = await db
    .updateTable("commitments")
    .set({ status: "expired", updated_at: sql`now()` })
    .where("status", "=", "pending")
    .where("deadline", "is not", null)
    .where("deadline", "<", sql<Date>`now() - interval '7 days'`)
    .executeTakeFirst();
  return Number(result.numUpdatedRows ?? 0n);
}
