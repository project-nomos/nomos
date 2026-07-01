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

import { z } from "zod";
import { loadEnvConfig } from "../config/env.ts";
import { upsertUserModel } from "../db/user-model.ts";
import { createLogger } from "../lib/logger.ts";
import { runReasoningFork } from "../sdk/reasoning-fork.ts";
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

// STABLE rubric + JSON-shape spec — byte-identical every call so it caches in the
// system-prompt prefix. Only the current-profile + new-edits pair (dynamic) is billed
// uncached, sent LAST as the fork input.
const DISTILL_INSTRUCTIONS = `You maintain a short profile of a user's PHOTO-EDITING taste, learned from the edits they actually apply. Update the CURRENT PROFILE given the NEW EDITS.

Capture only well-supported tendencies: tone (warm / cool / neutral), brightness and contrast, color (punchy / muted / natural), skin (smooth vs keep natural texture), what they tend to REMOVE (busy backgrounds, objects, blemishes) and KEEP (freckles, texture, grain), and any recurring style. Do not speculate from a single weak signal; keep the profile to 4-6 concise sentences.

Output ONLY JSON: {"profile": "<the full updated profile prose>", "prefs": {"tone": "...", "color": "...", "skin": "...", "contrast": "...", "removes": "...", "keeps": "..."}}. Use "" for any pref you cannot support yet.`;

/**
 * SDK-validated RAW shape of the distiller output. Kept transform-free so it can
 * be represented as JSON Schema for the SDK outputFormat (z.toJSONSchema throws on
 * .transform()). Normalization — trim/cap the profile, drop blank/non-string prefs,
 * skip when the profile is empty — happens in flushPhotoStyle after parsing, so a
 * blank profile there means "skip the write" rather than persisting a default.
 * Structured output makes the old double-emit workaround unnecessary.
 */
const DistilledStyleSchema = z.object({
  profile: z.string(),
  prefs: z.record(z.string(), z.unknown()).default({}),
});

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
  // Dynamic per-flush data only (current profile + the new edits); the rubric lives
  // in the cached DISTILL_INSTRUCTIONS prefix.
  const input = `CURRENT PROFILE:\n${current || "(none yet)"}\n\nNEW EDITS THE USER JUST APPLIED:\n${recent}`;
  const { data: parsed, raw } = await runReasoningFork({
    label: "studio-style",
    model: config.extractionModel ?? "claude-haiku-4-5",
    instructions: DISTILL_INSTRUCTIONS,
    input,
    schema: DistilledStyleSchema,
  });
  // On parse/validation failure `parsed` is null → skip the write rather than persist
  // a synthetic default into the vault + user_model.
  if (!parsed) {
    log.debug({ chars: raw.text.length }, "distill output not parseable; skipping");
    return;
  }
  // Normalize post-parse (was previously in the schema's transforms): trim + cap the
  // profile; a blank profile means skip the write. Drop blank/non-string prefs and
  // trim + cap each.
  const profile = parsed.profile.trim().slice(0, 1200);
  if (!profile) {
    log.debug("distilled profile empty; skipping");
    return;
  }
  const prefs: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed.prefs)) {
    if (typeof value === "string" && value.trim()) prefs[key] = value.trim().slice(0, 80);
  }
  // The editable prose profile, in the wiki/vault.
  await vaultWrite(userId, STYLE_NOTE, profile, { title: "Photo editing style" });
  // Structured, confidence-weighted prefs for injection.
  for (const [key, value] of Object.entries(prefs)) {
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
