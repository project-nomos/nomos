/**
 * Polite follow-up drafter (Bond gap plan, Phase 3).
 *
 * For items others owe the user (the "waiting on" lane) that are due for a nudge,
 * compose a short, polite chase message in the user's voice and STAGE it through
 * DraftManager under the platform's consent mode — never auto-send behind the
 * user's back. This is Bond's signature "politely follows up so you don't have
 * to", with Nomos's consent story on top.
 *
 * Routing: a follow-up is drafted on the item's ORIGINAL platform + thread
 * (source_ref) when that platform is a channel we can send on; otherwise it falls
 * back to the owner's default notification channel as a ready-to-send suggestion.
 * After a draft is staged we bump the item's follow-up counter and reschedule the
 * next nudge per the backoff (recordFollowUp).
 */

import { z } from "zod";
import type { DraftManager } from "../daemon/draft-manager.ts";
import {
  getCommitmentsDueForFollowUp,
  recordFollowUp,
  type CommitmentRow,
} from "./commitment-tracker.ts";
import { getKysely } from "../db/client.ts";
import { runReasoningFork } from "../sdk/reasoning-fork.ts";
import { getNotificationDefaultFor } from "../db/notification-defaults.ts";
import { createLogger } from "../lib/logger.ts";

const log = createLogger("followup-drafter");

/** Channel platforms we can register a send function for (draft is sendable there). */
const SENDABLE_CHANNELS = new Set(["slack", "imessage", "telegram", "whatsapp", "discord"]);

/** STABLE rubric — byte-identical every call; only the item detail is dynamic. */
const NUDGE_INSTRUCTIONS = `Write a SHORT, warm, polite follow-up message to gently chase something the sender is still waiting on. First person, as if the user wrote it themselves.

Rules:
- 1-2 sentences, no greeting line and no sign-off (the channel adds those).
- Friendly and low-pressure ("just circling back", "no rush, but"), never nagging.
- Reference the specific thing and, if it helps, the original ask.
- Plain language. No emoji unless clearly natural.

Return a JSON object {"message": "<the follow-up text>"}. Return ONLY the JSON object.`;

const NudgeSchema = z.object({ message: z.string().default("") });

/** Compose the nudge text for one waiting-on item. */
async function composeNudge(c: CommitmentRow, who: string | null): Promise<string | null> {
  const overdueDays = c.deadline
    ? Math.floor((Date.now() - c.deadline.getTime()) / 86_400_000)
    : null;
  const overdue =
    overdueDays !== null && overdueDays > 0 ? ` (about ${overdueDays} day(s) overdue)` : "";
  const target = who ? `Recipient: ${who}. ` : "";
  const input = `${target}Outstanding item: ${c.description}${overdue}. This is follow-up #${c.follow_up_count + 1}.`;
  const { data } = await runReasoningFork({
    instructions: NUDGE_INSTRUCTIONS,
    input,
    schema: NudgeSchema,
    label: "commitment-followup",
  });
  const text = data?.message?.trim();
  return text && text.length > 0 ? text : null;
}

/**
 * Draft follow-ups for a single owner's due waiting-on items. Returns the number
 * of drafts staged. Best-effort per item — one failure never blocks the rest.
 */
export async function draftFollowUpsForOwner(
  userId: string,
  draftManager: DraftManager,
): Promise<number> {
  const due = await getCommitmentsDueForFollowUp(userId);
  if (due.length === 0) return 0;

  const fallback = await getNotificationDefaultFor(userId);
  let staged = 0;

  for (const c of due) {
    try {
      // Resolve the other party's name (best-effort) for a warmer nudge.
      let who: string | null = null;
      if (c.contact_id) {
        const row = await getKysely()
          .selectFrom("contacts")
          .select("display_name")
          .where("user_id", "=", userId)
          .where("id", "=", c.contact_id)
          .executeTakeFirst();
        who = row?.display_name ?? null;
      }

      const message = await composeNudge(c, who);
      if (!message) {
        // Still advance the schedule so a bad compose doesn't retry every hour.
        await recordFollowUp(userId, c.id);
        continue;
      }

      // Prefer the original channel + thread; fall back to the default channel.
      const onOriginal = SENDABLE_CHANNELS.has(c.source);
      const platform = onOriginal ? c.source : (fallback?.platform ?? null);
      const channelId = onOriginal ? c.source_ref : (fallback?.channelId ?? null);
      if (!platform || !channelId) {
        // Nowhere to deliver it; advance the schedule and move on.
        await recordFollowUp(userId, c.id);
        continue;
      }

      const preface = onOriginal ? "" : `Follow-up for "${c.description}":\n`;
      await draftManager.createDraft(
        {
          inReplyTo: `followup:${c.id}`,
          platform,
          channelId,
          threadId: onOriginal ? (c.source_ref ?? undefined) : undefined,
          content: `${preface}${message}`,
        },
        userId,
        { kind: "commitment_followup", commitmentId: c.id },
      );
      await recordFollowUp(userId, c.id);
      staged++;
    } catch (err) {
      log.debug(
        { err: err instanceof Error ? err.message : err, id: c.id },
        "follow-up draft failed for item",
      );
    }
  }

  return staged;
}
