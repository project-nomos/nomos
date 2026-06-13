import { describe, expect, it } from "vitest";
import {
  assertIdentityPreserved,
  cosineSimilarity,
  type FaceEmbedder,
  IdentityDriftError,
} from "./identity-gate.ts";

describe("cosineSimilarity", () => {
  it("is 1 for identical vectors", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1);
  });
  it("is 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });
  it("is 0 for mismatched length or empty", () => {
    expect(cosineSimilarity([1], [1, 2])).toBe(0);
    expect(cosineSimilarity([], [])).toBe(0);
  });
});

describe("assertIdentityPreserved", () => {
  const img = new Uint8Array([1, 2, 3]);

  it("skips (passes) when no embedder is configured", async () => {
    const r = await assertIdentityPreserved(img, img);
    expect(r.checked).toBe(false);
    expect(r.passed).toBe(true);
  });

  it("passes when similarity meets the threshold", async () => {
    const embedder: FaceEmbedder = async () => [1, 2, 3];
    const r = await assertIdentityPreserved(img, img, { embedder });
    expect(r.checked).toBe(true);
    expect(r.score).toBeCloseTo(1);
    expect(r.passed).toBe(true);
  });

  it("throws IdentityDriftError below the threshold", async () => {
    let n = 0;
    const embedder: FaceEmbedder = async () => (n++ === 0 ? [1, 0, 0] : [0, 1, 0]); // orthogonal
    await expect(
      assertIdentityPreserved(img, img, { embedder, threshold: 0.6 }),
    ).rejects.toBeInstanceOf(IdentityDriftError);
  });

  it("skips when no face is found (embedder returns null)", async () => {
    const embedder: FaceEmbedder = async () => null;
    const r = await assertIdentityPreserved(img, img, { embedder });
    expect(r.checked).toBe(false);
    expect(r.passed).toBe(true);
  });
});
