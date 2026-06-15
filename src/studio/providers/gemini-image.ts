/**
 * Google generative image provider. Workhorse for the cloud ops (instruction
 * edit, eraser, cutout, upscale, restore). One SDK, two surfaces: the Gemini API
 * in dev, Vertex AI in prod (ADC / workload identity). GCP-only, no AWS.
 *
 * The model call goes through an injectable `GenAIImageClient`, so the provider
 * is unit-testable without credentials or a network. `createGoogleGenAIImageClient`
 * wraps `@google/genai` for the real path. Localized ops composite region-only
 * (mask-bounded paste-back) so untouched pixels never drift. A safety refusal is
 * surfaced as a typed ProviderRefusedError. See the design doc sections 2 + 6.
 */

import { GoogleGenAI } from "@google/genai";
import type { ProviderInput, ProviderOutput, StudioProvider } from "../engine.ts";
import { OP_META, type StudioOp, type StudioOpName } from "../ops.ts";
import { compositeMasked } from "./local-sharp.ts";

const GENERATIVE_OPS: readonly StudioOpName[] = [
  "editSemantic",
  "eraser",
  "cutout",
  "upscale",
  "restore",
  // Cloud fallback for retouch until the deterministic sidecar passes parity.
  "retouch",
  // Phase 3 generative depth bets.
  "muscle",
  "hairstyle",
  "beard",
  "relight",
  "expand",
  "sky",
];

export interface GenAIImageRequest {
  imageBase64: string;
  mimeType: string;
  prompt: string;
}

export interface GenAIImageResult {
  base64: string;
  mimeType: string;
}

export interface GenAIImageClient {
  readonly model: string;
  editImage(req: GenAIImageRequest): Promise<GenAIImageResult>;
}

/** The model refused (e.g. a safety filter on a face edit). The fallback lane / UI reacts. */
export class ProviderRefusedError extends Error {
  constructor(
    public readonly op: string,
    public readonly reason: string,
  ) {
    super(`Provider refused op ${op}: ${reason}`);
    this.name = "ProviderRefusedError";
  }
}

function promptFor(op: StudioOp): string {
  switch (op.op) {
    case "editSemantic":
      return op.params.instruction;
    case "eraser":
      return "Remove the masked object and naturally fill the background behind it. Keep everything else unchanged.";
    case "cutout":
      return "Cleanly cut out the main subject and remove the background.";
    case "upscale":
      return "Increase resolution and sharpness without changing the content or the person's identity.";
    case "restore":
      return "Restore this old or damaged photo: repair scratches, denoise, recover natural color. Do not change identity.";
    case "retouch":
      return "Subtly retouch this portrait: even out skin tone, soften blemishes and shine while keeping pores and natural texture. Do not change the person's identity, features, or proportions.";
    case "muscle":
      return `Add natural, photorealistic muscle definition to the ${op.params.area} (athletic, believable, not exaggerated). Keep the person's face, identity, and pose unchanged.`;
    case "hairstyle":
      return `Restyle the person's hair: ${op.params.style}. Keep the face, skin, and identity unchanged.`;
    case "beard":
      return op.params.action === "remove"
        ? "Cleanly remove the facial hair, leaving natural, realistic skin. Keep the person's identity unchanged."
        : op.params.action === "trim"
          ? `Neatly trim and tidy the facial hair${op.params.style ? `: ${op.params.style}` : ""}. Keep the person's identity unchanged.`
          : `Add a realistic, well-groomed beard${op.params.style ? `: ${op.params.style}` : ""}. Keep the person's face and identity unchanged.`;
    case "relight":
      return `Relight this photo${op.params.direction ? ` from the ${op.params.direction}` : ""}${op.params.mood ? `, ${op.params.mood} mood` : ""} with natural, believable shadows and highlights. Keep the content and composition unchanged.`;
    case "expand":
      return `Outpaint and naturally extend the scene (${op.params.direction}), seamlessly continuing the existing content, lighting, perspective, and style.`;
    case "sky":
      return `Replace the sky with ${op.params.style}, matching the scene's lighting, white balance, and reflections so it looks natural.`;
    default:
      return "Edit this image.";
  }
}

export interface GeminiImageProviderOptions {
  /** Display name + recorded provider ('gemini' dev, 'vertex' prod). */
  name?: string;
  /** Rough per-op platform cost recorded for metered billing (internal economics). */
  estimateCostUsd?: number;
}

export class GeminiImageProvider implements StudioProvider {
  readonly name: string;
  readonly kind = "generative" as const;
  private readonly cost: number;

  constructor(
    private readonly client: GenAIImageClient,
    opts: GeminiImageProviderOptions = {},
  ) {
    this.name = opts.name ?? "gemini";
    this.cost = opts.estimateCostUsd ?? 0.039;
  }

  supports(op: StudioOpName): boolean {
    return GENERATIVE_OPS.includes(op);
  }

  async execute(op: StudioOp, input: ProviderInput): Promise<ProviderOutput> {
    const result = await this.client.editImage({
      imageBase64: Buffer.from(input.bytes).toString("base64"),
      mimeType: input.mime,
      prompt: promptFor(op),
    });
    const modelBytes = new Uint8Array(Buffer.from(result.base64, "base64"));

    // Mask-bounded paste-back: composite the model output onto the original,
    // region-only, so untouched pixels stay bit-exact down the chain.
    if (input.maskBytes && OP_META[op.op].localized) {
      const composited = await compositeMasked(input.bytes, modelBytes, input.maskBytes);
      return { bytes: composited, mime: "image/jpeg", costUsd: this.cost, provider: this.name };
    }
    return { bytes: modelBytes, mime: result.mimeType, costUsd: this.cost, provider: this.name };
  }
}

/**
 * Real client over `@google/genai`. Dev uses the Gemini API key; prod uses Vertex
 * (ADC / workload identity). Selected by NOMOS_STUDIO_PROVIDER, else inferred from
 * GOOGLE_CLOUD_PROJECT. Never hard-wires the model.
 */
export function createGoogleGenAIImageClient(opts?: { model?: string }): GenAIImageClient {
  const model = opts?.model ?? process.env.NOMOS_STUDIO_GEMINI_MODEL ?? "gemini-2.5-flash-image";
  // Detection mirrors embeddings.ts: an API key (GOOGLE_API_KEY / GEMINI_API_KEY)
  // -> Gemini API; otherwise GOOGLE_CLOUD_PROJECT -> Vertex (ADC). Overridable.
  const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
  const surface = process.env.NOMOS_STUDIO_PROVIDER ?? (apiKey ? "gemini" : "vertex");

  const ai =
    surface === "vertex"
      ? new GoogleGenAI({
          vertexai: true,
          project: process.env.GOOGLE_CLOUD_PROJECT,
          location: process.env.CLOUD_ML_REGION ?? "us-central1",
        })
      : new GoogleGenAI({ apiKey });

  return {
    model,
    async editImage(req: GenAIImageRequest): Promise<GenAIImageResult> {
      const resp = await ai.models.generateContent({
        model,
        contents: [
          {
            role: "user",
            parts: [
              { inlineData: { mimeType: req.mimeType, data: req.imageBase64 } },
              { text: req.prompt },
            ],
          },
        ],
      });
      const candidate = resp.candidates?.[0];
      const parts = candidate?.content?.parts ?? [];
      for (const part of parts) {
        const data = part.inlineData?.data;
        if (data) {
          return { base64: data, mimeType: part.inlineData?.mimeType ?? "image/png" };
        }
      }
      const reason = candidate?.finishReason ?? "no image returned";
      throw new ProviderRefusedError("generate", String(reason));
    },
  };
}
