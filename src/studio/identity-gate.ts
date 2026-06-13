/**
 * Identity gate: a face-touching generative edit must not change WHO is in the
 * photo. It compares a face embedding of the input vs the output (cosine
 * similarity); below threshold => IdentityDriftError, and the engine retries
 * softer or surfaces "this changed your face too much".
 *
 * The embedder is pluggable (an on-device Vision embedding shipped up with the
 * request, or a server model). When no embedder is configured the gate SKIPS and
 * logs, so dev/eval run without an embedding model while the contract + wiring
 * already exist. A manifest invariant requires every face-touching generative op
 * to pass through here. See nomos-docs/studio-plan.md section 7.
 */

import { createLogger } from "../lib/logger.ts";

const log = createLogger("studio-identity-gate");

/** Returns an embedding vector, or null when no face is detected (not a face edit). */
export type FaceEmbedder = (image: Uint8Array) => Promise<number[] | null>;

export const DEFAULT_IDENTITY_THRESHOLD = 0.6;

let configuredEmbedder: FaceEmbedder | null = null;

/** Install the process-wide face embedder (e.g. a server model on boot). */
export function setFaceEmbedder(embedder: FaceEmbedder | null): void {
  configuredEmbedder = embedder;
}

export class IdentityDriftError extends Error {
  constructor(
    public readonly score: number,
    public readonly threshold: number,
  ) {
    super(`Identity drift: face similarity ${score.toFixed(3)} below ${threshold}`);
    this.name = "IdentityDriftError";
  }
}

export interface IdentityResult {
  /** false = skipped (no embedder, or no face in either image). */
  checked: boolean;
  score: number | null;
  passed: boolean;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Throws IdentityDriftError when the output face has drifted below threshold from
 * the input. Skips (passed=true, checked=false) when no embedder is configured or
 * no face is present in either image.
 */
export async function assertIdentityPreserved(
  input: Uint8Array,
  output: Uint8Array,
  opts?: { threshold?: number; embedder?: FaceEmbedder },
): Promise<IdentityResult> {
  const embedder = opts?.embedder ?? configuredEmbedder;
  if (!embedder) {
    log.warn("identity gate skipped: no face embedder configured");
    return { checked: false, score: null, passed: true };
  }
  const [ein, eout] = await Promise.all([embedder(input), embedder(output)]);
  if (!ein || !eout) {
    // No face in one side -> not a face edit; nothing for this gate to protect.
    return { checked: false, score: null, passed: true };
  }
  const score = cosineSimilarity(ein, eout);
  const threshold = opts?.threshold ?? DEFAULT_IDENTITY_THRESHOLD;
  if (score < threshold) throw new IdentityDriftError(score, threshold);
  return { checked: true, score, passed: true };
}
