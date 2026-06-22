/**
 * Emotional presence: a durable, decaying log of mood EPISODES — never a standing state.
 *
 * The live `theory-of-mind` read is always primary for the current session. This module
 * persists only the *episode and its cause* ("they were stretched about the Q3 launch")
 * so the agent can (a) follow up on the cause next time and (b) notice recurring patterns
 * — without ever assuming today's mood from yesterday's. Episodes decay; one bad day is
 * an episode, not a trait. Stored as an editable `mood-log.md` vault note, user_id-scoped.
 *
 * Gated behind NOMOS_ADAPTIVE_MEMORY (the same flag as the rest of learning). This is
 * supportive companionship, never therapy or crisis care — see docs/stress-anxiety-support.md.
 */

import { z } from "zod";
import { loadEnvConfig } from "../config/env.ts";
import { createLogger } from "../lib/logger.ts";
import { runForkedAgent } from "../sdk/forked-agent.ts";
import { vaultRead, vaultWrite } from "./vault.ts";

/** Phase C — schema for SDK-validated structured output (parseMoodCapture validates further). */
const MoodCaptureSchema = z.object({
  strain: z.boolean(),
  emotion: z.string().optional(),
  cause: z.string().optional(),
});

const log = createLogger("mood-log");

const MOOD_NOTE = "mood-log.md";
const MAX_AGE_DAYS = 30; // episodes older than this decay out
const MAX_EPISODES = 20;
const DAY_MS = 86_400_000;

export interface MoodEpisode {
  /** ISO date (YYYY-MM-DD) the episode was last observed. */
  date: string;
  /** A coarse read: stressed | frustrated | overwhelmed | low-energy | anxious | … */
  emotion: string;
  /** What it was about — the stressor/thread, not the person. */
  cause: string;
  /** open = the agent hasn't heard it resolve; resolved = drop from active context. */
  status: "open" | "resolved";
}

function enabled(): boolean {
  return loadEnvConfig().adaptiveMemory;
}

const SEP = " · ";

/** Parse `mood-log.md` (one `- date · emotion · cause · status` line per episode). */
export function parseMoodLog(content: string): MoodEpisode[] {
  const out: MoodEpisode[] = [];
  for (const raw of content.split("\n")) {
    const line = raw.replace(/^\s*-\s*/, "").trim();
    if (!line) continue;
    const parts = line.split(SEP).map((p) => p.trim());
    if (parts.length < 3) continue;
    const [date, emotion, cause, status] = parts;
    if (!date || !emotion || !cause) continue;
    out.push({ date, emotion, cause, status: status === "resolved" ? "resolved" : "open" });
  }
  return out;
}

function renderMoodLog(episodes: MoodEpisode[]): string {
  const lines = episodes.map(
    (e) => `- ${e.date}${SEP}${e.emotion}${SEP}${e.cause}${SEP}${e.status}`,
  );
  return [
    "# Mood log",
    "",
    "Episodes (not a standing state) — what was weighing on you and whether it recurs.",
    "",
    ...lines,
  ].join("\n");
}

/** Drop episodes older than MAX_AGE_DAYS (and cap at MAX_EPISODES, newest first). */
function decay(episodes: MoodEpisode[], nowMs: number): MoodEpisode[] {
  const cutoff = nowMs - MAX_AGE_DAYS * DAY_MS;
  return episodes
    .filter((e) => {
      const t = Date.parse(e.date);
      return Number.isNaN(t) || t >= cutoff;
    })
    .sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0))
    .slice(0, MAX_EPISODES);
}

/**
 * Record (or update) a mood episode keyed by its cause. Same cause → refresh the date +
 * emotion (it recurred or continued); new cause → a new episode. Never overwrites the
 * live read; this is only the durable trace. No-op when adaptive memory is off.
 */
export async function recordMoodEpisode(
  userId: string,
  emotion: string,
  cause: string,
  opts?: { status?: "open" | "resolved"; nowMs?: number },
): Promise<void> {
  if (!enabled()) return;
  const e = emotion.trim();
  const c = cause.trim();
  if (!e || !c) return;
  const nowMs = opts?.nowMs ?? Date.now();
  const date = new Date(nowMs).toISOString().slice(0, 10);

  const existing = (await vaultRead(userId, MOOD_NOTE))?.content ?? "";
  const episodes = parseMoodLog(existing);

  const key = c.toLowerCase();
  const match = episodes.find((ep) => ep.cause.toLowerCase() === key);
  if (match) {
    match.date = date;
    match.emotion = e;
    match.status = opts?.status ?? match.status;
  } else {
    episodes.push({ date, emotion: e, cause: c, status: opts?.status ?? "open" });
  }

  await vaultWrite(userId, MOOD_NOTE, renderMoodLog(decay(episodes, nowMs)), {
    title: "Mood log",
  });
}

/** Recent OPEN episodes (decayed), so the agent can follow up on the cause — not the feeling. */
export async function readOpenMoodEpisodes(
  userId: string,
  nowMs = Date.now(),
): Promise<MoodEpisode[]> {
  if (!enabled()) return [];
  const note = await vaultRead(userId, MOOD_NOTE);
  if (!note?.content.trim()) return [];
  return decay(parseMoodLog(note.content), nowMs).filter((e) => e.status === "open");
}

const CAPTURE_PROMPT = `You read one exchange between a user and their AI companion, plus a coarse emotion signal. If — and only if — the user shows genuine strain (stress, frustration, overwhelm, anxiety, low energy), name WHAT it is about in a few words (the cause/thread, e.g. "the Q3 launch", "their manager", "the migration bug"). Do NOT invent strain that isn't there.

Output ONLY JSON: {"strain": true|false, "emotion": "stressed|frustrated|overwhelmed|anxious|low-energy", "cause": "<a few words>"}. If no real strain, {"strain": false}.`;

/** Parse the capture distiller's JSON (tolerant; null if no real strain). */
export function parseMoodCapture(text: string): { emotion: string; cause: string } | null {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const raw = JSON.parse(cleaned.slice(start, end + 1)) as {
      strain?: unknown;
      emotion?: unknown;
      cause?: unknown;
    };
    if (raw.strain !== true) return null;
    if (typeof raw.emotion !== "string" || typeof raw.cause !== "string") return null;
    const emotion = raw.emotion.trim().slice(0, 40);
    const cause = raw.cause.trim().slice(0, 120);
    return emotion && cause ? { emotion, cause } : null;
  } catch {
    return null;
  }
}

/**
 * Production trigger: when the live theory-of-mind flagged strain this turn, name the
 * cause (cheap forked pass) and record the episode. Best-effort, fire-and-forget.
 */
export async function captureMoodFromTurn(
  userId: string,
  userMessage: string,
  tomSummary: string,
): Promise<void> {
  if (!enabled()) return;
  const config = loadEnvConfig();
  try {
    const result = await runForkedAgent({
      label: "mood-capture",
      model: config.extractionModel ?? "claude-haiku-4-5",
      allowedTools: [],
      prompt: `${CAPTURE_PROMPT}\n\nEMOTION SIGNAL: ${tomSummary}\n\nUSER MESSAGE:\n${userMessage.slice(0, 1200)}`,
      outputSchema: MoodCaptureSchema,
    });
    // Prefer the SDK-validated structured output; parseMoodCapture validates the
    // strain/emotion/cause shape either way (it accepts the stringified object).
    const parsed = parseMoodCapture(
      result.structuredOutput !== undefined ? JSON.stringify(result.structuredOutput) : result.text,
    );
    if (parsed) await recordMoodEpisode(userId, parsed.emotion, parsed.cause);
  } catch (err) {
    log.debug({ err: err instanceof Error ? err.message : String(err) }, "mood capture failed");
  }
}
