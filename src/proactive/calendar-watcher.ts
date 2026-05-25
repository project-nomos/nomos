/**
 * Calendar watcher — periodically scans the upcoming calendar window via
 * the google-workspace MCP and produces a pre-meeting brief for any event
 * starting in the next 10-30 minutes.
 *
 * Like the inbox watcher, this runs through the main AgentRuntime so the
 * agent has gws calendar tools and can call into the meeting-briefer logic
 * indirectly (via contact lookups + memory search).
 */

import { NOACTION_PREFIX, parseIntervalMinutes, type ProactiveJobSpec } from "./inbox-watcher.ts";

export function buildCalendarScanPrompt(scanIntervalMinutes: number): string {
  // We want to brief meetings starting in [lower, upper] minutes from now.
  // Use a window slightly bigger than the scan interval so each meeting is
  // briefed exactly once (the lower bound is the scan interval; the upper
  // is lower + 5 min slop).
  const lower = scanIntervalMinutes;
  const upper = scanIntervalMinutes + 10;

  return `You are scanning my calendar for meetings that need a pre-meeting brief.

TASK:
1. Use the google-workspace calendar tools to list events on my primary calendar starting between ${lower} and ${upper} minutes from now.
2. For each upcoming event:
   - Skip if it has no other attendees, is all-day, or is marked as declined by me.
   - Otherwise, build a brief. For attendees, use memory_search and the identity graph to find prior context (recent conversations, role, last discussed topic). Pull any relevant wiki articles.
   - Include the meeting title, time, attendees (with relationships), 2-3 sentences of context, and 2-3 suggested talking points or questions.

REPLY FORMAT:
- If no eligible meetings, respond with exactly: ${NOACTION_PREFIX} no upcoming meetings
- Otherwise, one brief per meeting using Slack mrkdwn:
  *<title>* — <local time>
  *Attendees:* <name (role) · name (role)>
  *Context:* <2-3 sentences>
  *Talking points:*
  • <point>
  • <point>

Keep each brief under 1500 characters. Plain language, no preamble.`;
}

export function calendarScanJobSpec(interval: string): ProactiveJobSpec {
  const minutes = parseIntervalMinutes(interval, 5);
  return {
    name: "proactive:calendar-watcher",
    schedule: interval,
    scheduleType: "every",
    prompt: buildCalendarScanPrompt(minutes),
  };
}
