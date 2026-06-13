/**
 * Studio op registry: the single, versioned vocabulary every edit is recorded
 * in. The iOS app, the engine, and the (Phase 3) sidecar all speak these ops,
 * so "undo / before-after / redo softer" and re-editability work across
 * interfaces and versions.
 *
 * Bump OP_SPEC_VERSION on any breaking param change. Swift mirrors these by hand
 * in v1 (codegen is a tracked TODO); a contract test pins the Swift encodings
 * against this version. See nomos-docs/studio-plan.md section 3 (op registry).
 */

import { z } from "zod";

export const OP_SPEC_VERSION = 1;

/** Normalized -1..1 slider value. */
const unit = z.number().min(-1).max(1);

const adjust = z.strictObject({
  exposure: unit.optional(),
  contrast: unit.optional(),
  highlights: unit.optional(),
  shadows: unit.optional(),
  temperature: unit.optional(),
  tint: unit.optional(),
  saturation: unit.optional(),
  vibrance: unit.optional(),
  clarity: unit.optional(),
});

const crop = z.strictObject({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  width: z.number().min(0).max(1),
  height: z.number().min(0).max(1),
  rotate: z.number().min(-180).max(180).optional(),
});

const filter = z.strictObject({
  id: z.string().min(1),
  intensity: z.number().min(0).max(1).default(1),
});

/** Natural-language instruction edit. Localized (region-only paste-back) when a mask is present. */
const editSemantic = z.strictObject({
  instruction: z.string().min(1).max(1000),
  strength: z.number().min(0).max(1).optional(),
  maskKey: z.string().optional(),
});

/** Mask-bounded object removal (magic eraser). */
const eraser = z.strictObject({
  maskKey: z.string().min(1),
});

/** Background removal. Device mask when present, else server matte. */
const cutout = z.strictObject({
  maskKey: z.string().optional(),
});

const upscale = z.strictObject({
  factor: z.union([z.literal(2), z.literal(4)]).default(2),
});

const restore = z.strictObject({});

export const OP_SCHEMAS = {
  adjust,
  crop,
  filter,
  editSemantic,
  eraser,
  cutout,
  upscale,
  restore,
} as const;

export type StudioOpName = keyof typeof OP_SCHEMAS;

export type StudioOpParams = {
  [K in StudioOpName]: z.infer<(typeof OP_SCHEMAS)[K]>;
};

/** A validated op record as stored in the op chain. */
export type StudioOp = {
  [K in StudioOpName]: { op: K; params: StudioOpParams[K]; opSpecVersion: number };
}[StudioOpName];

export interface OpMeta {
  /** deterministic = pod CPU / on-device; generative = cloud model (Gemini/Vertex). */
  kind: "deterministic" | "generative";
  /** Engine composites region-only (mask-bounded paste-back) when a mask is available. */
  localized: boolean;
  /** Identity-drift risk; drives per-op routing + the identity gate (plan section 7). */
  identityRisk: "none" | "low" | "high";
}

export const OP_META: Record<StudioOpName, OpMeta> = {
  adjust: { kind: "deterministic", localized: false, identityRisk: "none" },
  crop: { kind: "deterministic", localized: false, identityRisk: "none" },
  filter: { kind: "deterministic", localized: false, identityRisk: "none" },
  editSemantic: { kind: "generative", localized: true, identityRisk: "high" },
  eraser: { kind: "generative", localized: true, identityRisk: "low" },
  cutout: { kind: "deterministic", localized: false, identityRisk: "none" },
  upscale: { kind: "generative", localized: false, identityRisk: "low" },
  restore: { kind: "generative", localized: false, identityRisk: "high" },
};

export function isStudioOpName(op: string): op is StudioOpName {
  return Object.hasOwn(OP_SCHEMAS, op);
}

export class UnknownOpError extends Error {
  constructor(public readonly op: string) {
    super(`Unknown studio op: ${op}`);
    this.name = "UnknownOpError";
  }
}

/**
 * Validate + normalize an op record before it is appended to the chain. Throws
 * UnknownOpError for an unknown op name, or a ZodError for invalid params.
 */
export function validateOp(input: { op: string; params?: unknown }): StudioOp {
  if (!isStudioOpName(input.op)) throw new UnknownOpError(input.op);
  const params = OP_SCHEMAS[input.op].parse(input.params ?? {});
  return { op: input.op, params, opSpecVersion: OP_SPEC_VERSION } as StudioOp;
}
