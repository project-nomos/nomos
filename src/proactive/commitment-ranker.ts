/**
 * Commitment ranker (Bond gap plan, Phase 2).
 *
 * Turns the flat action list into a RANKED one: a single reasoning fork scores
 * each pending item p0..p3 with a one-line reason, and the scores are written
 * back onto the rows (priority + rank_reason). The morning briefing and Today
 * brief then render FROM the ranked list rather than re-deriving order each time.
 *
 * The rubric is byte-stable (cached prefix per the reasoning-fork contract); only
 * the item list is dynamic. Enrichment signals (a contact's role/importance) are
 * folded into the dynamic item line, not the rubric, so the prefix stays stable.
 */

import { z } from "zod";
import { getKysely } from "../db/client.ts";
import { runReasoningFork } from "../sdk/reasoning-fork.ts";
import { getActionItems, setPriority, type CommitmentRow } from "./commitment-tracker.ts";
import { createLogger } from "../lib/logger.ts";

const log = createLogger("commitment-ranker");

/** STABLE rubric — byte-identical every call; only the item list is dynamic. */
const RANK_INSTRUCTIONS = `You are ranking a person's open action items by leverage, so the single most important thing sits at the top of their day.

Assign each item a priority:
- "p0": do-now. A hard deadline today/overdue, a blocker on someone else, or high-stakes (money, legal, a key relationship).
- "p1": important and time-sensitive this week; needs the person specifically.
- "p2": matters but can wait, or can be delegated.
- "p3": low-value, routine, or nice-to-have.

Weigh: deadline proximity (sooner = higher), who it's with (a manager/investor/customer outranks a routine contact), whether others are blocked waiting on it, and alignment with the person's stated goals. Items others owe the PERSON ("waiting on" items) are usually lower unless overdue and blocking.

Input is a numbered list. Return a JSON object {"rankings": [{"n": <the item number>, "priority": "p0|p1|p2|p3", "reason": "<≤12 words>"}]} with one entry per item. Return ONLY the JSON object.`;

const RankingSchema = z.object({
  rankings: z
    .array(
      z.object({
        n: z.number().int(),
        priority: z.enum(["p0", "p1", "p2", "p3"]).catch("p2"),
        reason: z.string().default(""),
      }),
    )
    .default([]),
});

/** Render one item as a stable, compact line for the ranker prompt. */
function itemLine(n: number, c: CommitmentRow, who: string | null): string {
  const dir = c.direction === "theirs" ? "waiting-on" : "todo";
  const due = c.deadline ? ` due=${c.deadline.toISOString().slice(0, 10)}` : "";
  const with_ = who ? ` with=${who}` : "";
  return `${n}. [${dir}]${due}${with_} ${c.description}`;
}

/**
 * Rank an owner's pending action items and persist priority + rank_reason.
 * Returns the number of items ranked. Best-effort: a fork failure leaves items
 * unranked (they still sort last, so the list is never broken).
 */
export async function rankActionItems(userId: string, maxItems = 30): Promise<number> {
  const items = await getActionItems(userId, { limit: maxItems });
  if (items.length === 0) return 0;

  // Pull each linked contact's role so importance rides in the dynamic line.
  const contactIds = [...new Set(items.map((c) => c.contact_id).filter(Boolean))] as string[];
  const roleByContact = new Map<string, string>();
  if (contactIds.length > 0) {
    const rows = await getKysely()
      .selectFrom("contacts")
      .select(["id", "display_name", "role"])
      .where("user_id", "=", userId)
      .where("id", "in", contactIds)
      .execute();
    for (const r of rows) {
      const label = [r.display_name, r.role].filter(Boolean).join(", ");
      if (label) roleByContact.set(r.id, label);
    }
  }

  const list = items
    .map((c, i) =>
      itemLine(i + 1, c, c.contact_id ? (roleByContact.get(c.contact_id) ?? null) : null),
    )
    .join("\n");

  const { data } = await runReasoningFork({
    instructions: RANK_INSTRUCTIONS,
    input: `ITEMS:\n${list}`,
    schema: RankingSchema,
    label: "commitment-ranking",
  });
  if (!data) {
    log.debug({ userId }, "ranker produced nothing; leaving items unranked");
    return 0;
  }

  let ranked = 0;
  for (const r of data.rankings) {
    const item = items[r.n - 1];
    if (!item) continue;
    await setPriority(userId, item.id, r.priority, r.reason.slice(0, 200)).catch(() => {});
    ranked++;
  }
  log.debug({ userId, ranked }, "ranked action items");
  return ranked;
}
