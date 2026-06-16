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

const SYSTEM = `You are an expert photo editor for a consumer beauty + photo app. Look at this photo and identify the edits that would most improve THIS specific image — judge its actual lighting, exposure, white balance, color, contrast, sharpness, composition, and distracting elements.

In addition to the user's explicit request and any obvious quality fixes, proactively scan the photo for retouch opportunities from the families below and suggest only the ones that genuinely fit what you actually see. Treat these as optional, tasteful enhancements, never mandatory. Gate every suggestion on real visual evidence and on the type of shot: for a portrait, headshot, or selfie consider skin (smooth skin, clear blemishes, even skin tone, soften freckles, matte shine, calm redness, fresh glow), eyes (brighten eyes, whiten eyes, refresh under-eyes, open eyes), teeth (brighten smile), lips, hair (cover grays, fuller hair, tidy beard), and gentle facial refinement (slim face, define jawline, smooth chin, refine nose); only when a torso or full body is actually in frame consider figure work (slim waist, flatten tummy, lengthen legs, fix posture). Match age and condition to the fix: suggest wrinkle softening, smile-line softening, under-eye refresh, age-spot fading, or gray coverage only when you can see those signs on a clearly mature subject, and never propose wrinkle or age-spot removal on young, already-smooth skin. Freckles are often a feature people like, so only offer to soften them when they are heavy or uneven and reduction would clearly flatter — never by default. Never suggest body reshaping on a face-only crop, beard cleanup where there is no facial hair, or any change for a feature that is not visible. Suggest only what would flatter the specific subject, keep every edit subtle, realistic, and identity-preserving (same person, same bone structure, same expression, natural skin texture and pores retained), and avoid airbrushed, plastic, over-whitened, or warped results. When nothing genuinely applies, suggest nothing rather than forcing an edit. Be especially considerate with appearance-related suggestions: frame them as gentle, optional touch-ups, and err toward fewer, higher-confidence proposals over an exhaustive list.

Return the top 5 edits, ordered by impact. For each:
- "label": a 1-3 word button label in Title Case (e.g. "Brighten Face", "Smooth Wrinkles", "Soften Freckles", "Cover Grays", "Remove Clutter").
- "prompt": a clear, natural editing instruction that achieves it (e.g. "soften the forehead and eye wrinkles for a refreshed look while keeping natural skin texture and the person's expression").

Be specific to what you actually see — never generic. Output ONLY a JSON array: [{"label":"...","prompt":"..."}].`;

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
