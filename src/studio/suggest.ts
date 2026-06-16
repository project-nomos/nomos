/**
 * AI-native edit suggestions. The heart of the editor dock: a vision model looks at
 * THIS photo and proposes the highest-impact fixes as short, tap-to-apply prompts —
 * so the chips are about the actual image, not a static toolbar.
 *
 * Gemini 2.5 Flash (vision -> text), reusing the studio surface/credentials. Text
 * output, so no IMAGE_SAFETY path; the configurable text-safety categories are relaxed
 * (the user is editing their own photo with consent). Always degrades to [] on any
 * failure so the editor falls back to its static chips.
 */

import { Buffer } from "node:buffer";
import { createLogger } from "../lib/logger.ts";
import { createGenAI, relaxedSafetyFor } from "./providers/gemini-image.ts";

const log = createLogger("studio-suggest");

export interface EditSuggestion {
  /** 1-3 word chip label, Title Case (e.g. "Brighten Face"). */
  label: string;
  /** The natural-language edit instruction applied on tap (editSemantic). */
  prompt: string;
}

const SYSTEM = `You are an expert photo editor. Look at this photo and identify the edits that would most improve THIS specific image — judge its actual lighting, exposure, white balance, color, contrast, sharpness, composition, distracting elements, and (if a person is present) skin/eyes, or (if a landscape) sky/foreground.

Return the top 5 edits, ordered by impact. For each:
- "label": a 1-3 word button label in Title Case (e.g. "Brighten Face", "Warm Tones", "Remove Clutter", "Sharpen Eyes").
- "prompt": a clear, natural editing instruction that achieves it (e.g. "brighten the underexposed face and gently lift the shadows", "remove the distracting signpost on the left and fill the background naturally").

Be specific to what you actually see — never generic. Keep it realistic; preserve the person's identity. Output ONLY a JSON array: [{"label":"...","prompt":"..."}].`;

interface RawSuggestion {
  label?: unknown;
  prompt?: unknown;
}

/** Analyze image bytes and return up to `count` tap-to-apply edit suggestions. */
export async function suggestEdits(
  bytes: Uint8Array,
  mime: string,
  opts?: { model?: string; count?: number },
): Promise<EditSuggestion[]> {
  const model = opts?.model ?? process.env.NOMOS_STUDIO_SUGGEST_MODEL ?? "gemini-2.5-flash";
  const count = opts?.count ?? 5;
  try {
    const { ai } = createGenAI();
    const resp = await ai.models.generateContent({
      model,
      contents: [
        {
          role: "user",
          parts: [
            { inlineData: { mimeType: mime, data: Buffer.from(bytes).toString("base64") } },
            { text: SYSTEM },
          ],
        },
      ],
      config: {
        responseMimeType: "application/json",
        // Text output: only the configurable text categories apply (never the image
        // ones, which would 400 on the Gemini API surface).
        safetySettings: relaxedSafetyFor("gemini"),
      },
    });
    return parseSuggestions(resp.text ?? textFromCandidates(resp), count);
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, "studio suggest failed");
    return [];
  }
}

/** Some SDK shapes expose text only on the candidate parts; this is the fallback. */
function textFromCandidates(resp: unknown): string {
  const parts =
    (resp as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> })
      ?.candidates?.[0]?.content?.parts ?? [];
  return parts.map((p) => p.text ?? "").join("");
}

/** Tolerant parse: trims code fences, validates shape, clamps lengths + count. */
export function parseSuggestions(text: string, count = 5): EditSuggestion[] {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();
  let raw: unknown;
  try {
    raw = JSON.parse(cleaned);
  } catch {
    return [];
  }
  const arr: RawSuggestion[] = Array.isArray(raw)
    ? (raw as RawSuggestion[])
    : Array.isArray((raw as { suggestions?: unknown }).suggestions)
      ? (raw as { suggestions: RawSuggestion[] }).suggestions
      : [];
  const out: EditSuggestion[] = [];
  for (const item of arr) {
    if (typeof item?.label !== "string" || typeof item?.prompt !== "string") continue;
    const label = item.label.trim().slice(0, 28);
    const prompt = item.prompt.trim().slice(0, 280);
    if (label && prompt) out.push({ label, prompt });
    if (out.length >= count) break;
  }
  return out;
}
