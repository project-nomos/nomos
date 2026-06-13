import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { validateOp } from "../ops.ts";
import { type GenAIImageClient, GeminiImageProvider } from "./gemini-image.ts";

async function solid(
  w: number,
  h: number,
  color: { r: number; g: number; b: number },
): Promise<Uint8Array> {
  return new Uint8Array(
    await sharp({ create: { width: w, height: h, channels: 3, background: color } })
      .png()
      .toBuffer(),
  );
}

function fakeClient(result: Uint8Array, mimeType = "image/png"): GenAIImageClient {
  return {
    model: "fake-model",
    editImage: vi.fn(async () => ({
      base64: Buffer.from(result).toString("base64"),
      mimeType,
    })),
  };
}

describe("GeminiImageProvider", () => {
  it("supports generative ops only", () => {
    const p = new GeminiImageProvider(fakeClient(new Uint8Array([1])));
    expect(p.supports("editSemantic")).toBe(true);
    expect(p.supports("eraser")).toBe(true);
    expect(p.supports("upscale")).toBe(true);
    expect(p.supports("adjust")).toBe(false);
    expect(p.supports("crop")).toBe(false);
  });

  it("editSemantic sends the instruction as the prompt and returns model bytes + cost", async () => {
    const modelOut = await solid(10, 10, { r: 0, g: 255, b: 0 });
    const client = fakeClient(modelOut, "image/png");
    const provider = new GeminiImageProvider(client, { name: "gemini", estimateCostUsd: 0.039 });
    const op = validateOp({ op: "editSemantic", params: { instruction: "warm it up" } });
    const out = await provider.execute(op, {
      bytes: await solid(10, 10, { r: 255, g: 0, b: 0 }),
      mime: "image/jpeg",
      params: op.params,
    });
    expect(client.editImage).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "warm it up" }),
    );
    expect(out.provider).toBe("gemini");
    expect(out.costUsd).toBe(0.039);
    expect(out.mime).toBe("image/png"); // no mask -> raw model output
  });

  it("eraser with a mask composites region-only and returns a jpeg", async () => {
    const original = await solid(20, 20, { r: 255, g: 0, b: 0 });
    const modelOut = await solid(20, 20, { r: 0, g: 0, b: 255 });
    const mask = await solid(20, 20, { r: 255, g: 255, b: 255 });
    const provider = new GeminiImageProvider(fakeClient(modelOut));
    const op = validateOp({ op: "eraser", params: { maskKey: "m1" } });
    const out = await provider.execute(op, {
      bytes: original,
      mime: "image/jpeg",
      params: op.params,
      maskBytes: mask,
    });
    expect(out.mime).toBe("image/jpeg"); // composited path
    const meta = await sharp(Buffer.from(out.bytes)).metadata();
    expect(meta.format).toBe("jpeg");
    expect(meta.width).toBe(20);
  });
});
