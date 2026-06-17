/**
 * Studio learning: turn the photo edits a user actually applies into a durable sense
 * of their taste, then feed it back into auto-enhance + personalized recommendations —
 * the same extract -> user-model/vault -> inject loop the rest of the app uses.
 *
 * Capture is a fire-and-forget signal per committed generative edit. Distillation is a
 * cheap background pass (every few edits) that updates a `photo-style.md` vault note (so
 * it lives in the wiki and the user can read/edit it) plus `photo_style` user_model
 * entries. Gated behind NOMOS_ADAPTIVE_MEMORY (same flag as all other learning).
 */

import { loadEnvConfig } from "../config/env.ts";
import { upsertUserModel } from "../db/user-model.ts";
import { createLogger } from "../lib/logger.ts";
import { runForkedAgent } from "../sdk/forked-agent.ts";
import { vaultRead, vaultWrite } from "../memory/vault.ts";

const log = createLogger("studio-learn");

const STYLE_NOTE = "photo-style.md";
const FLUSH_EVERY = 4; // distill after this many newly-applied edits

interface EditSignal {
  op: string;
  instruction: string;
}

// Per-user in-memory buffer of recent edit signals + a guard against concurrent flushes.
// Un-flushed signals are lost on restart (only ~3) — the distilled profile is durable.
const buffers = new Map<string, EditSignal[]>();
const flushing = new Set<string>();

function enabled(): boolean {
  return loadEnvConfig().adaptiveMemory;
}

const DISTILL_PROMPT = `You maintain a short profile of a user's PHOTO-EDITING taste, learned from the edits they actually apply. Update the CURRENT PROFILE given the NEW EDITS.

Capture only well-supported tendencies: tone (warm / cool / neutral), brightness and contrast, color (punchy / muted / natural), skin (smooth vs keep natural texture), what they tend to REMOVE (busy backgrounds, objects, blemishes) and KEEP (freckles, texture, grain), and any recurring style. Do not speculate from a single weak signal; keep the profile to 4-6 concise sentences.

Output ONLY JSON: {"profile": "<the full updated profile prose>", "prefs": {"tone": "...", "color": "...", "skin": "...", "contrast": "...", "removes": "...", "keeps": "..."}}. Use "" for any pref you cannot support yet.`;

interface DistilledStyle {
  profile: string;
  prefs: Record<string, string>;
}

/**
 * Scan out the first brace-balanced {...} object (string-aware), so we recover the
 * JSON even when the model wraps it in prose or — as Haiku sometimes does — emits the
 * same fenced object twice back-to-back (which defeats a naive first-{ ... last-}).
 */
function firstJsonObject(s: string): string | null {
  const start = s.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') {
      inStr = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Tolerant parse of the distiller's JSON. Tries the whole (de-fenced) string first,
 * then the first brace-balanced object — covering fenced, prose-wrapped, and
 * duplicated-block outputs.
 */
export function parseStyle(text: string): DistilledStyle | null {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();
  const candidates = [cleaned];
  const obj = firstJsonObject(cleaned);
  if (obj) candidates.push(obj);

  for (const candidate of candidates) {
    let raw: { profile?: unknown; prefs?: unknown };
    try {
      raw = JSON.parse(candidate) as { profile?: unknown; prefs?: unknown };
    } catch {
      continue;
    }
    if (typeof raw.profile !== "string" || !raw.profile.trim()) continue;
    const prefs: Record<string, string> = {};
    if (raw.prefs && typeof raw.prefs === "object") {
      for (const [k, v] of Object.entries(raw.prefs as Record<string, unknown>)) {
        if (typeof v === "string" && v.trim()) prefs[k] = v.trim().slice(0, 80);
      }
    }
    return { profile: raw.profile.trim().slice(0, 1200), prefs };
  }
  return null;
}

/** Record one applied edit as a learning signal; distills in the background every few. */
export async function recordEditSignal(
  userId: string,
  op: string,
  instruction: string,
): Promise<void> {
  if (!enabled()) return;
  const text = instruction.trim();
  if (!text) return;
  const buf = buffers.get(userId) ?? [];
  buf.push({ op, instruction: text.slice(0, 200) });
  buffers.set(userId, buf);
  if (buf.length >= FLUSH_EVERY && !flushing.has(userId)) {
    const batch = buf.splice(0, buf.length);
    flushing.add(userId);
    try {
      await flushPhotoStyle(userId, batch);
    } catch (err) {
      log.debug({ err: err instanceof Error ? err.message : String(err) }, "style flush failed");
    } finally {
      flushing.delete(userId);
    }
  }
}

/** Distill the batch (+ current profile) into the photo-style note + user_model entries. */
export async function flushPhotoStyle(userId: string, signals: EditSignal[]): Promise<void> {
  if (!signals.length) return;
  const config = loadEnvConfig();
  const current = (await vaultRead(userId, STYLE_NOTE))?.content ?? "";
  const recent = signals.map((s) => `- ${s.op}: ${s.instruction}`).join("\n");
  const result = await runForkedAgent({
    label: "studio-style",
    model: config.extractionModel ?? "claude-haiku-4-5",
    allowedTools: [],
    prompt: `${DISTILL_PROMPT}\n\nCURRENT PROFILE:\n${current || "(none yet)"}\n\nNEW EDITS THE USER JUST APPLIED:\n${recent}`,
  });
  const parsed = parseStyle(result.text);
  if (!parsed) {
    log.debug({ chars: result.text.length }, "distill output not parseable; skipping");
    return;
  }
  // The editable prose profile, in the wiki/vault.
  await vaultWrite(userId, STYLE_NOTE, parsed.profile, { title: "Photo editing style" });
  // Structured, confidence-weighted prefs for injection.
  for (const [key, value] of Object.entries(parsed.prefs)) {
    await upsertUserModel({
      userId,
      category: "photo_style",
      key,
      value,
      sourceIds: [],
      confidence: 0.7,
    });
  }
}

/** The user's learned photo-editing style for prompt injection ("" if none / disabled). */
export async function readPhotoStyle(userId: string): Promise<string> {
  if (!enabled()) return "";
  const note = await vaultRead(userId, STYLE_NOTE);
  return note?.content.trim() ?? "";
}
