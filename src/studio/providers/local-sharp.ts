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

const DETERMINISTIC_OPS: readonly StudioOpName[] = ["adjust", "crop", "deviceRender"];

/** Hard ceiling on a committed device render's long edge (defense-in-depth). */
const MAX_DEVICE_EDGE = 4096;

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
  readonly kind = "deterministic" as const;

  supports(op: StudioOpName): boolean {
    return DETERMINISTIC_OPS.includes(op);
  }

  async execute(op: StudioOp, input: ProviderInput): Promise<ProviderOutput> {
    let img = sharp(Buffer.from(input.bytes));
    if (op.op === "adjust") {
      img = applyAdjust(img, op.params);
    } else if (op.op === "crop") {
      img = await applyCrop(img, op.params);
    } else if (op.op === "deviceRender") {
      // The bytes ARE the result (rendered on-device). Re-encode through sharp to
      // strip EXIF/GPS, reject a malformed upload, and clamp the long edge.
      img = img.rotate().resize(MAX_DEVICE_EDGE, MAX_DEVICE_EDGE, {
        fit: "inside",
        withoutEnlargement: true,
      });
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

export interface MaskBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * The bounding box of the brushed (white) region of a mask, in the ORIGINAL's pixel
 * space, padded by `padFrac` of the box's larger side and clamped to the image. Returns
 * null when the mask is empty (caller falls back to a whole-image edit). This is what
 * lets a region edit CROP to the marked area so the model focuses there.
 */
export async function maskBoundingBox(
  mask: Uint8Array,
  width: number,
  height: number,
  padFrac = 0.08,
): Promise<MaskBox | null> {
  if (width <= 0 || height <= 0) return null;
  const { data } = await sharp(Buffer.from(mask))
    .resize(width, height, { fit: "fill" })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[y * width + x] > 127) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null; // no brushed pixels
  const pad = Math.round(Math.max(maxX - minX, maxY - minY) * padFrac) + 1;
  const left = Math.max(0, minX - pad);
  const top = Math.max(0, minY - pad);
  const right = Math.min(width, maxX + pad + 1);
  const bottom = Math.min(height, maxY + pad + 1);
  return { left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
}

/** The brushed-region box for an original + mask (reads the original's pixel dims). */
export async function regionBox(
  original: Uint8Array,
  mask: Uint8Array,
  padFrac = 0.08,
): Promise<MaskBox | null> {
  const meta = await sharp(Buffer.from(original)).metadata();
  return maskBoundingBox(mask, meta.width ?? 0, meta.height ?? 0, padFrac);
}

/** Extract the masked region from the original (a JPEG crop the model edits in isolation). */
export async function cropRegion(original: Uint8Array, box: MaskBox): Promise<Uint8Array> {
  const out = await sharp(Buffer.from(original))
    .extract({ left: box.left, top: box.top, width: box.width, height: box.height })
    .jpeg({ quality: 95 })
    .toBuffer();
  return new Uint8Array(out);
}

/**
 * Paste an edited crop back into the original at `box`, blended by the brushed mask
 * (cropped to the box + lightly feathered) so only the marked area changes and the rest
 * stays bit-exact at the ORIGINAL dimensions — no reframing, no whole-image replacement.
 */
export async function compositeRegion(
  original: Uint8Array,
  editedCrop: Uint8Array,
  mask: Uint8Array,
  box: MaskBox,
): Promise<Uint8Array> {
  const base = sharp(Buffer.from(original));
  const meta = await base.metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;

  const editedRgb = await sharp(Buffer.from(editedCrop))
    .resize(box.width, box.height, { fit: "fill" })
    .removeAlpha()
    .toBuffer();
  const feather = Math.max(0.5, Math.min(box.width, box.height) * 0.02);
  const alpha = await sharp(Buffer.from(mask))
    .resize(width, height, { fit: "fill" })
    .extract({ left: box.left, top: box.top, width: box.width, height: box.height })
    .greyscale()
    .blur(feather)
    .toColourspace("b-w")
    .toBuffer();

  const editedWithAlpha = await sharp(editedRgb).joinChannel(alpha).png().toBuffer();
  const out = await base
    .composite([{ input: editedWithAlpha, left: box.left, top: box.top, blend: "over" }])
    .jpeg({ quality: 92 })
    .toBuffer();
  return new Uint8Array(out);
}
