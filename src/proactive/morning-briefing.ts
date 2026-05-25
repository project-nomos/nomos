/**
 * Morning briefing — a once-daily aggregation of today's calendar, overnight
 * email, open commitments, and suggested focus. Pushed to the default
 * notification channel via the cron engine's `announce` mode.
 */

import { NOACTION_PREFIX, type ProactiveJobSpec } from "./inbox-watcher.ts";

/** Default cron expression: 8:00 AM every day in the server's local time. */
export const DEFAULT_BRIEFING_CRON = "0 8 * * *";

export function buildMorningBriefingPrompt(): string {
  return `It's the start of my day. Build my morning briefing.

TASK — gather and summarize:
1. *Today's calendar* — use google-workspace calendar tools to list today's events on my primary calendar. Note conflicts, back-to-backs, gaps suitable for deep work.
2. *Overnight inbox* — use gmail tools to list unread INBOX messages received since 6pm yesterday. Group: urgent / needs-reply / FYI. Skip junk.
3. *Open commitments* — use memory_search for promises I've made that are due today or overdue. Cross-reference with the commitments tracker if needed.
4. *Suggested focus* — given the calendar gaps and open commitments, suggest 1-3 deep-work blocks.

REPLY FORMAT — Slack mrkdwn, under 2000 chars, no preamble:

*Morning. Here's your day.*

*Calendar*
• <time> — <title> (<attendees>)
... (note conflicts/back-to-backs at the end of this section if any)

*Inbox* (<N> unread)
_Urgent:_ <sender · subject>
_Needs reply:_ <sender · subject>
(omit "FYI" line unless count > 5, then just say "+N FYI")

*Commitments due today*
• <commitment> — <to whom>
(if none, write "None tracked")

*Suggested focus*
• <HH:MM-HH:MM> — <what>

If there's literally nothing on the calendar, no unread mail, and no commitments, respond with exactly: ${NOACTION_PREFIX} quiet day`;
}

export function morningBriefingJobSpec(cronExpression: string): ProactiveJobSpec {
  return {
    name: "proactive:morning-briefing",
    schedule: cronExpression,
    scheduleType: "cron",
    prompt: buildMorningBriefingPrompt(),
  };
}
