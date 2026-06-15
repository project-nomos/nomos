import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  OP_META,
  OP_SCHEMAS,
  OP_SPEC_VERSION,
  type StudioOpName,
  UnknownOpError,
  validateOp,
} from "./ops.ts";

describe("studio op registry", () => {
  it("validates a tonal adjust op and stamps the spec version", () => {
    const op = validateOp({ op: "adjust", params: { exposure: 0.34, contrast: -0.1 } });
    expect(op.op).toBe("adjust");
    expect(op.opSpecVersion).toBe(OP_SPEC_VERSION);
    expect(op.params).toEqual({ exposure: 0.34, contrast: -0.1 });
  });

  it("applies defaults (filter intensity)", () => {
    const op = validateOp({ op: "filter", params: { id: "terracotta" } });
    expect(op.params).toEqual({ id: "terracotta", intensity: 1 });
  });

  it("rejects an unknown op with UnknownOpError", () => {
    expect(() => validateOp({ op: "facelift", params: {} })).toThrow(UnknownOpError);
  });

  it("rejects out-of-range slider values", () => {
    expect(() => validateOp({ op: "adjust", params: { exposure: 5 } })).toThrow(z.ZodError);
  });

  it("rejects an eraser with no mask (mask-bounded only)", () => {
    expect(() => validateOp({ op: "eraser", params: {} })).toThrow(z.ZodError);
  });

  it("strips unknown keys is OFF: extra params are rejected (strict)", () => {
    expect(() => validateOp({ op: "upscale", params: { factor: 2, sharpen: true } })).toThrow(
      z.ZodError,
    );
  });

  it("defaults params to {} when omitted (restore takes none)", () => {
    const op = validateOp({ op: "restore" });
    expect(op).toEqual({ op: "restore", params: {}, opSpecVersion: OP_SPEC_VERSION });
  });

  it("every op name has metadata for routing + the identity gate", () => {
    for (const name of Object.keys(OP_SCHEMAS) as StudioOpName[]) {
      expect(OP_META[name]).toBeDefined();
      expect(["deterministic", "generative"]).toContain(OP_META[name].kind);
      expect(["none", "low", "high"]).toContain(OP_META[name].identityRisk);
    }
  });

  it("face-touching generative ops are flagged high identity-risk", () => {
    expect(OP_META.editSemantic.identityRisk).toBe("high");
    expect(OP_META.restore.identityRisk).toBe("high");
    expect(OP_META.adjust.identityRisk).toBe("none");
  });

  it("cutout is a cloud op (generative) so the consent gate covers it", () => {
    // Regression: cutout was mislabeled deterministic and bypassed consent.
    expect(OP_META.cutout.kind).toBe("generative");
    expect(OP_META.adjust.kind).toBe("deterministic");
    expect(OP_META.crop.kind).toBe("deterministic");
  });

  it("deviceRender is free, never consent- or identity-gated (WYSIWYG on-device)", () => {
    const op = validateOp({ op: "deviceRender", params: { tool: "makeup", detail: "lips" } });
    expect(op.params).toEqual({ tool: "makeup", detail: "lips" });
    expect(OP_META.deviceRender.kind).toBe("deterministic");
    expect(OP_META.deviceRender.identityRisk).toBe("none");
  });

  it("deviceRender requires a tool label", () => {
    expect(() => validateOp({ op: "deviceRender", params: {} })).toThrow(z.ZodError);
  });
});
