/**
 * Pod-local deterministic provider (sharp / libvips). Runs the free,
 * unmetered ops (tonal adjust, crop), generates the ~256px history preview, and
 * provides the mask-bounded paste-back compositor that keeps untouched pixels
 * bit-exact for localized generative ops. No network, no cost.
 *
 * Fine tonal control (highlights/shadows/clarity, true white balance) is Phase 2
 * on-device (Core Image); this is the server baseline for the agent path.
 */

import sharp from "sharp";
import type { ProviderInput, ProviderOutput, StudioProvider } from "../engine.ts";
import type { StudioOp, StudioOpName } from "../ops.ts";

const DETERMINISTIC_OPS: readonly StudioOpName[] = ["adjust", "crop"];

const clampPos = (n: number): number => Math.max(0.01, n);

type AdjustParams = {
  exposure?: number;
  contrast?: number;
  saturation?: number;
  temperature?: number;
};

function applyAdjust(img: sharp.Sharp, params: AdjustParams): sharp.Sharp {
  let out = img;
  const brightness = 1 + (params.exposure ?? 0) * 0.5;
  const saturation = clampPos(1 + (params.saturation ?? 0));
  const hue = Math.round((params.temperature ?? 0) * 12); // warm/cool approximation
  if (
    params.exposure !== undefined ||
    params.saturation !== undefined ||
    params.temperature !== undefined
  ) {
    out = out.modulate({ brightness: clampPos(brightness), saturation, hue });
  }
  if (params.contrast !== undefined) {
    const a = 1 + params.contrast * 0.5; // slope around mid-grey
    const b = 128 * (1 - a);
    out = out.linear(a, b);
  }
  return out;
}

type CropParams = { x: number; y: number; width: number; height: number; rotate?: number };

async function applyCrop(img: sharp.Sharp, params: CropParams): Promise<sharp.Sharp> {
  const meta = await img.metadata();
  const W = meta.width ?? 0;
  const H = meta.height ?? 0;
  const left = Math.min(W - 1, Math.max(0, Math.round(params.x * W)));
  const top = Math.min(H - 1, Math.max(0, Math.round(params.y * H)));
  const width = Math.max(1, Math.min(W - left, Math.round(params.width * W)));
  const height = Math.max(1, Math.min(H - top, Math.round(params.height * H)));
  let out = img.extract({ left, top, width, height });
  if (params.rotate) out = out.rotate(params.rotate);
  return out;
}

export class LocalSharpProvider implements StudioProvider {
  readonly name = "local-sharp";

  supports(op: StudioOpName): boolean {
    return DETERMINISTIC_OPS.includes(op);
  }

  async execute(op: StudioOp, input: ProviderInput): Promise<ProviderOutput> {
    let img = sharp(Buffer.from(input.bytes));
    if (op.op === "adjust") {
      img = applyAdjust(img, op.params);
    } else if (op.op === "crop") {
      img = await applyCrop(img, op.params);
    } else {
      throw new Error(`local-sharp does not support op: ${op.op}`);
    }
    const bytes = await img.jpeg({ quality: 92 }).toBuffer();
    return { bytes: new Uint8Array(bytes), mime: "image/jpeg", costUsd: 0, provider: this.name };
  }
}

/** ~256px JPEG preview for the history strip. Returns null on a non-image input. */
export async function makePreview(bytes: Uint8Array, _mime: string): Promise<Uint8Array | null> {
  try {
    const out = await sharp(Buffer.from(bytes))
      .resize(256, 256, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();
    return new Uint8Array(out);
  } catch {
    return null;
  }
}

/**
 * Mask-bounded paste-back: composite the edited image over the original using a
 * single-channel mask as alpha, so only the masked region changes and every
 * untouched pixel stays exactly the original. The mask is resized to match.
 */
export async function compositeMasked(
  original: Uint8Array,
  edited: Uint8Array,
  mask: Uint8Array,
): Promise<Uint8Array> {
  const base = sharp(Buffer.from(original));
  const meta = await base.metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;

  const editedRgb = await sharp(Buffer.from(edited))
    .resize(width, height, { fit: "fill" })
    .removeAlpha()
    .toBuffer();
  const alpha = await sharp(Buffer.from(mask))
    .resize(width, height, { fit: "fill" })
    .greyscale()
    .toColourspace("b-w")
    .toBuffer();

  const editedWithAlpha = await sharp(editedRgb).joinChannel(alpha).png().toBuffer();
  const out = await base
    .composite([{ input: editedWithAlpha, blend: "over" }])
    .jpeg({ quality: 92 })
    .toBuffer();
  return new Uint8Array(out);
}
