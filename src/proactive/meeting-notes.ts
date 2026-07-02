/**
 * Meeting-notes watcher (Bond gap plan, Phase 4).
 *
 * The calendar watcher briefs meetings BEFORE they start; this one runs AFTER a
 * meeting ends and mines its notes/transcript for decisions and commitments —
 * closing the loop so "you promised X in the standup" lands on the action list
 * automatically, and post-meeting follow-ups (Phase 3) flow from it.
 *
 * Source A (lowest friction, shipped here): Google Meet transcripts + Gemini
 * "meeting notes" surfaced via the google-workspace tools (a notes doc in Drive
 * and/or a recap email in Gmail). Runs through the main AgentRuntime so it has
 * gws + the todo_add / memory_write tools. Granola (local markdown/API) is a
 * later source that can feed the same extraction.
 */

import { NOACTION_PREFIX, parseIntervalMinutes, type ProactiveJobSpec } from "./inbox-watcher.ts";

export function buildMeetingNotesPrompt(scanIntervalMinutes: number): string {
  // Look at meetings that ENDED in the last window so each is processed once.
  const lookback = scanIntervalMinutes + 15;

  return `You are reviewing meetings that recently ended, to capture what was decided and who owes what.

TASK:
1. Use the google-workspace calendar tools to list events on my primary calendar that ENDED in the last ${lookback} minutes and had other attendees (skip solo blocks, all-day items, and events I declined).
2. For each such meeting, look for its notes: a Google Meet transcript or a Gemini "meeting notes" doc in Drive (search Drive for the meeting title/date), and/or a recap email in Gmail. If you find none, skip that meeting silently — do NOT invent notes.
3. From the notes, extract:
   - Decisions and key outcomes → write a concise summary to my long-term memory with memory_write at path "meetings/<yyyy-mm-dd>-<slug>.md" (revise if it exists).
   - COMMITMENTS in BOTH directions → add each with todo_add:
     • something I agreed to do → direction "mine".
     • something someone else agreed to get me → direction "theirs".
     Always pass source "meeting", set sourceRef to the meeting's calendar event id, include the other person as contact and any due date. Call todo_list first and skip items already captured (match on the same task).

REPLY FORMAT:
- If the Calendar/Drive tools are unavailable or error so you cannot ACTUALLY scan, respond with exactly: ${NOACTION_PREFIX} meeting-notes unavailable — and NOTHING else.
- If there were no eligible meetings or none had notes, respond with exactly: ${NOACTION_PREFIX} no meeting notes
- Otherwise, one short block per meeting using Slack mrkdwn:
  *<title>* — <local end time>
  *Decisions:* <1-2 sentences>
  *Captured:* <N> commitment(s)

Keep each block under 1000 characters. Plain language, no preamble.`;
}

export function meetingNotesJobSpec(interval: string): ProactiveJobSpec {
  const minutes = parseIntervalMinutes(interval, 30);
  return {
    name: "proactive:meeting-notes",
    schedule: interval,
    scheduleType: "every",
    prompt: buildMeetingNotesPrompt(minutes),
  };
}
