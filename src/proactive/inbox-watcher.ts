/**
 * Inbox watcher — periodically scans Gmail via the google-workspace MCP,
 * classifies unread messages, and (depending on autonomy level) creates
 * reply drafts via DraftManager.
 *
 * The job runs through the main AgentRuntime (not a forked agent) so it
 * has full MCP access (gws gmail tools + DraftManager). The agent's
 * response is routed to the default notification channel via the cron
 * engine's `announce` delivery mode, unless prefixed with the NOACTION
 * sentinel.
 */

import type { NomosConfig } from "../config/env.ts";

/** Sentinel prefix the agent uses when there's nothing worth notifying. */
export const NOACTION_PREFIX = "[NOACTION]";

export type InboxAutonomy = NomosConfig["inboxAutonomy"];

export interface ProactiveJobSpec {
  /** Stable job name (used for idempotent upsert). */
  name: string;
  /** Schedule string compatible with the configured `scheduleType`. */
  schedule: string;
  /** "every" | "cron" — `every` accepts shorthand like "15m". */
  scheduleType: "every" | "cron";
  /** Prompt content sent through the agent runtime. */
  prompt: string;
}

const AUTONOMY_INSTRUCTIONS: Record<InboxAutonomy, string> = {
  off: "",
  passive: "DO NOT create drafts or send anything. Only report what needs my attention.",
  active:
    "For messages that need a reply, use the DraftManager (via slack-mcp draft tools or the gmail draft tool) to stage a draft for my approval. Do not send anything without approval. Brief, plain-language drafts in my voice.",
  aggressive:
    "For low-stakes replies (meeting confirmations, RSVP yes/no to known senders, simple acknowledgements, calendar moves), send directly via gmail. For anything ambiguous, sensitive, or to unfamiliar senders, stage a draft instead. Be conservative — when in doubt, draft.",
};

/**
 * Build the agent prompt for one inbox scan.
 *
 * The agent has access to the google-workspace MCP (gmail tools) and the
 * default-channel DraftManager. We tell it exactly what to do per autonomy
 * level and what to return.
 */
export function buildInboxScanPrompt(autonomy: InboxAutonomy, lookbackMinutes: number): string {
  const autonomyLine = AUTONOMY_INSTRUCTIONS[autonomy];

  return `You are scanning my inbox for messages that need attention.

TASK:
1. Use the google-workspace gmail tools to list UNREAD messages in INBOX received in the last ${lookbackMinutes} minutes.
2. For each, decide: urgent / needs-reply / FYI / junk.
3. Skip junk and FYI silently.
4. ${autonomyLine}
5. Before staging a draft, check existing drafts for that thread FIRST (list drafts). NEVER create a second draft for a message you have already drafted — if a draft already exists for the thread, skip it. Do not re-draft the same email on later scans.

REPLY FORMAT:
- If the Gmail tool is unavailable or errors this run so you cannot ACTUALLY scan, respond with exactly: ${NOACTION_PREFIX} gmail unavailable — and NOTHING else. Do not announce that a tool is disconnected or that you will retry; the next run retries automatically.
- If nothing urgent or actionable was found, respond with exactly: ${NOACTION_PREFIX} inbox clean
- Otherwise respond with a terse summary (no preamble), grouped:
  *Urgent* — sender · subject · 1-line why
  *Needs reply* — sender · subject · 1-line proposed reply or "draft staged"
  *Drafts staged* (only if you created drafts) — sender · subject

Keep the summary under 1000 characters total. Use Slack mrkdwn (bold via *asterisks*, no markdown headings). Do not include greetings or sign-offs.`;
}

/** Job specification for the inbox watcher. */
export function inboxScanJobSpec(autonomy: InboxAutonomy, interval: string): ProactiveJobSpec {
  // Lookback should overlap a bit with the scan interval so brief downtime
  // doesn't lose messages. Parse simple "Nm" / "Nh" forms; default to 20 min.
  const lookbackMinutes = parseIntervalMinutes(interval, 15) + 5;

  return {
    name: "proactive:inbox-watcher",
    schedule: interval,
    scheduleType: "every",
    prompt: buildInboxScanPrompt(autonomy, lookbackMinutes),
  };
}

/** Parse a short interval string like "15m", "2h", "30s" into minutes. */
export function parseIntervalMinutes(s: string, fallback: number): number {
  const m = s.match(/^(\d+)\s*([smhd])?$/i);
  if (!m) return fallback;
  const n = parseInt(m[1], 10);
  const unit = (m[2] ?? "m").toLowerCase();
  switch (unit) {
    case "s":
      return Math.max(1, Math.ceil(n / 60));
    case "m":
      return n;
    case "h":
      return n * 60;
    case "d":
      return n * 60 * 24;
    default:
      return fallback;
  }
}
