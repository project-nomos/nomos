/**
 * Classroom watcher — periodically scans Google Classroom via the classroom MCP
 * tools and surfaces (a) assignments due soon that haven't been turned in, and
 * (b) upcoming exams/quizzes worth prepping for.
 *
 * Like the inbox/calendar watchers, it runs through the main AgentRuntime (which
 * has the classroom_* tools + memory) and assembles the nudge itself. Delivered to
 * the default notification channel via the cron engine's `announce` mode; the
 * `[NOACTION]` sentinel suppresses noise on quiet runs.
 *
 * Gated on FEATURES.classroom() + the classroomScan config flag (see scheduler.ts).
 */

import { NOACTION_PREFIX, parseIntervalMinutes, type ProactiveJobSpec } from "./inbox-watcher.ts";

export function buildClassroomScanPrompt(scanIntervalMinutes: number): string {
  const days = Math.max(1, Math.round(scanIntervalMinutes / (60 * 24)) || 3);

  return `You are scanning my Google Classroom for things I should act on.

TASK:
1. Use your Google Classroom tools to list my active courses.
2. For each course, list its coursework (ordered by due date) and my own submissions (across all coursework) to find assignments DUE within the next ${days} day(s) that I have NOT turned in (submission state is not TURNED_IN/RETURNED).
3. Also flag any upcoming assessment — coursework whose title looks like an exam, quiz, test, midterm, or final — due soon, and (from the posted course materials and my past grades) note 1-2 weak topics worth prepping.

REPLY FORMAT:
- If nothing is due soon and no exam is approaching, respond with exactly: ${NOACTION_PREFIX} nothing due
- Otherwise, a short Slack-mrkdwn digest:
  *Due soon*
  • <course> — <assignment> (due <local time>) — _not turned in_
  *Exam prep*
  • <course> — <exam> on <date>: focus on <topic>, <topic>

Keep it under 1200 characters. Do NOT draft or submit anything here — just surface what needs attention. Plain language, no preamble.`;
}

export function classroomDueDateJobSpec(interval: string): ProactiveJobSpec {
  const minutes = parseIntervalMinutes(interval, 360);
  return {
    name: "proactive:classroom-watcher",
    schedule: interval,
    scheduleType: "every",
    prompt: buildClassroomScanPrompt(minutes),
  };
}
