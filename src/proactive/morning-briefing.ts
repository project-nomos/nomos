/**
 * Morning briefing — a once-daily aggregation of today's calendar, overnight
 * email, open commitments, and suggested focus. Pushed to the default
 * notification channel via the cron engine's `announce` mode.
 */

import { NOACTION_PREFIX, type ProactiveJobSpec } from "./inbox-watcher.ts";

/** Default cron expression: 8:00 AM every day in the server's local time. */
export const DEFAULT_BRIEFING_CRON = "0 8 * * *";

export function buildMorningBriefingPrompt(): string {
  return `It's the start of my day. Build my morning briefing FROM my ranked action list.

TASK — gather and summarize:
1. *My action list* — call todo_list to get my ranked items (they are already ordered p0..p3, most important first). Split them into:
   - "Needs you": items I owe (direction mine) at p0/p1.
   - "Waiting on others": items others owe me (direction theirs) — note anything overdue.
   - "Handled / delegated": items marked delegated, or drafts you've already staged for me.
2. *Today's calendar* — use google-workspace calendar tools to list today's events on my primary calendar. Note conflicts, back-to-backs, gaps suitable for deep work.
3. *Overnight inbox* — use gmail tools to list unread INBOX messages received since 6pm yesterday. Group: urgent / needs-reply / FYI. Skip junk. (Capture any new commitments into my list with todo_add as you go.)
4. *Suggested focus* — given the calendar gaps and my p0/p1 items, suggest 1-3 deep-work blocks.

REPLY FORMAT — Slack mrkdwn, under 2000 chars, no preamble:

*Morning. Here's your day.*

*Needs you*
• <item> — <why it's ranked here>
(the top line is your single most important thing)

*Waiting on others*
• <item> — <who> (<overdue age if any>)
(omit this section if empty)

*Calendar*
• <time> — <title> (<attendees>)
... (note conflicts/back-to-backs at the end of this section if any)

*Inbox* (<N> unread)
_Urgent:_ <sender · subject>
_Needs reply:_ <sender · subject>
(omit "FYI" line unless count > 5, then just say "+N FYI")

*Suggested focus*
• <HH:MM-HH:MM> — <what>

If there is literally nothing on my list, nothing on the calendar, and no unread mail, respond with exactly: ${NOACTION_PREFIX} quiet day`;
}

export function morningBriefingJobSpec(cronExpression: string): ProactiveJobSpec {
  return {
    name: "proactive:morning-briefing",
    schedule: cronExpression,
    scheduleType: "cron",
    prompt: buildMorningBriefingPrompt(),
  };
}
