/**
 * Commitment tracker.
 *
 * Extracts commitments (promises, deadlines, follow-ups) from conversations
 * via a forked agent. Stores them in the commitments table and triggers
 * reminders via cron.
 */

import { getDb } from "../db/client.ts";
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

  const sql = getDb();
  const stored: CommitmentRow[] = [];

  for (const c of commitments) {
    const [row] = await sql<CommitmentRow[]>`
      INSERT INTO commitments (description, source_msg, deadline)
      VALUES (${c.description}, ${sourceMsg ?? null}, ${c.deadline ? new Date(c.deadline) : null})
      RETURNING *
    `;
    stored.push(row);
  }

  return stored;
}

/**
 * Get pending commitments, optionally filtered by upcoming deadlines.
 */
export async function getPendingCommitments(daysAhead?: number): Promise<CommitmentRow[]> {
  const sql = getDb();

  if (daysAhead !== undefined) {
    return sql<CommitmentRow[]>`
      SELECT * FROM commitments
      WHERE status = 'pending'
        AND deadline IS NOT NULL
        AND deadline <= now() + interval '1 day' * ${daysAhead}
      ORDER BY deadline ASC
    `;
  }

  return sql<CommitmentRow[]>`
    SELECT * FROM commitments
    WHERE status = 'pending'
    ORDER BY deadline ASC NULLS LAST, created_at DESC
  `;
}

/**
 * Mark a commitment as completed.
 */
export async function completeCommitment(id: string): Promise<void> {
  const sql = getDb();
  await sql`
    UPDATE commitments
    SET status = 'completed', updated_at = now()
    WHERE id = ${id}
  `;
}

/**
 * Get commitments due for reminders (deadline within 24h, not yet reminded).
 */
export async function getCommitmentsForReminder(): Promise<CommitmentRow[]> {
  const sql = getDb();
  return sql<CommitmentRow[]>`
    SELECT * FROM commitments
    WHERE status = 'pending'
      AND reminded = false
      AND deadline IS NOT NULL
      AND deadline <= now() + interval '24 hours'
    ORDER BY deadline ASC
  `;
}

/**
 * Mark commitments as reminded.
 */
export async function markReminded(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const sql = getDb();
  await sql`
    UPDATE commitments
    SET reminded = true, updated_at = now()
    WHERE id = ANY(${ids})
  `;
}

/**
 * Expire overdue commitments (past deadline by more than 7 days).
 */
export async function expireOverdueCommitments(): Promise<number> {
  const sql = getDb();
  const result = await sql`
    UPDATE commitments
    SET status = 'expired', updated_at = now()
    WHERE status = 'pending'
      AND deadline IS NOT NULL
      AND deadline < now() - interval '7 days'
  `;
  return result.count;
}
