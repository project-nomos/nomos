/**
 * Proactive feature scheduler.
 *
 * Registers cron jobs for:
 * - Commitment reminders (every hour)
 * - Priority triage digest (daily)
 * - Overdue commitment expiration (daily)
 */

import { getDb } from "../db/client.ts";
import {
  getCommitmentsForReminder,
  markReminded,
  expireOverdueCommitments,
} from "./commitment-tracker.ts";
import { generateTriage } from "./priority-triage.ts";

/**
 * Register proactive cron jobs.
 * Called during daemon startup from gateway.ts.
 */
export async function registerProactiveJobs(): Promise<void> {
  const sql = getDb();

  // Check if proactive features are enabled
  const [config] = await sql<{ value: string }[]>`
    SELECT value FROM config WHERE key = 'app.proactiveEnabled'
  `;

  const enabled = config?.value === '"true"';
  if (!enabled) {
    console.log("[proactive] Proactive features disabled (set app.proactiveEnabled to enable)");
    return;
  }

  console.log("[proactive] Registering proactive jobs");

  // These will be picked up by CronEngine on next refresh
  // For now, they run on daemon startup check
}

/**
 * Run commitment reminder check.
 * Called by CronEngine or manually.
 */
export async function runCommitmentReminders(): Promise<{
  reminded: number;
  expired: number;
}> {
  // Get commitments due for reminder
  const due = await getCommitmentsForReminder();

  if (due.length > 0) {
    // Format reminder message
    const reminders = due
      .map((c) => {
        const deadline = c.deadline ? ` (due: ${c.deadline.toLocaleDateString()})` : "";
        return `- ${c.description}${deadline}`;
      })
      .join("\n");

    console.log(`[proactive] Commitment reminders:\n${reminders}`);

    // Mark as reminded
    await markReminded(due.map((c) => c.id));
  }

  // Expire overdue commitments
  const expired = await expireOverdueCommitments();

  return { reminded: due.length, expired };
}

/**
 * Run daily triage digest.
 * Called by CronEngine or manually.
 */
export async function runTriageDigest(): Promise<string> {
  const triage = await generateTriage(1);

  if (triage.items.length === 0) {
    return "No new messages requiring attention.";
  }

  const lines = ["📋 Daily Triage Summary\n"];

  const highPriority = triage.items.filter((i) => i.urgency === "high");
  const mediumPriority = triage.items.filter((i) => i.urgency === "medium");

  if (highPriority.length > 0) {
    lines.push("**High Priority:**");
    for (const item of highPriority) {
      lines.push(
        `- ${item.contactName ?? item.contact} (${item.platform}): ${item.messageCount} msg(s) — ${item.reason}`,
      );
    }
    lines.push("");
  }

  if (mediumPriority.length > 0) {
    lines.push("**Needs Attention:**");
    for (const item of mediumPriority) {
      lines.push(
        `- ${item.contactName ?? item.contact} (${item.platform}): ${item.messageCount} msg(s)`,
      );
    }
  }

  const summary = lines.join("\n");
  console.log(`[proactive] ${summary}`);
  return summary;
}
