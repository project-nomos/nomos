import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { validateOp } from "../ops.ts";
import { compositeMasked, LocalSharpProvider, makePreview } from "./local-sharp.ts";

async function solid(
  w: number,
  h: number,
  color: { r: number; g: number; b: number },
): Promise<Uint8Array> {
  const buf = await sharp({ create: { width: w, height: h, channels: 3, background: color } })
    .jpeg()
    .toBuffer();
  return new Uint8Array(buf);
}

describe("LocalSharpProvider", () => {
  const provider = new LocalSharpProvider();

  it("supports only deterministic ops", () => {
    expect(provider.supports("adjust")).toBe(true);
    expect(provider.supports("crop")).toBe(true);
    expect(provider.supports("deviceRender")).toBe(true);
    expect(provider.supports("editSemantic")).toBe(false);
    expect(provider.supports("upscale")).toBe(false);
  });

  it("deviceRender re-encodes the uploaded render to a clean jpeg, clamped to 4096px", async () => {
    const img = await solid(5000, 2000, { r: 30, g: 60, b: 90 });
    const op = validateOp({ op: "deviceRender", params: { tool: "makeup", detail: "lips" } });
    const out = await provider.execute(op, { bytes: img, mime: "image/jpeg", params: op.params });
    expect(out.provider).toBe("local-sharp");
    expect(out.costUsd).toBe(0);
    const meta = await sharp(Buffer.from(out.bytes)).metadata();
    expect(meta.format).toBe("jpeg");
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(4096);
  });

  it("deviceRender rejects a malformed upload", async () => {
    const op = validateOp({ op: "deviceRender", params: { tool: "makeup" } });
    await expect(
      provider.execute(op, {
        bytes: new Uint8Array([1, 2, 3]),
        mime: "image/jpeg",
        params: op.params,
      }),
    ).rejects.toThrow();
  });

  it("applies a tonal adjust and returns a same-size jpeg at zero cost", async () => {
    const img = await solid(64, 48, { r: 100, g: 110, b: 120 });
    const op = validateOp({
      op: "adjust",
      params: { exposure: 0.3, contrast: 0.2, saturation: 0.1 },
    });
    const out = await provider.execute(op, { bytes: img, mime: "image/jpeg", params: op.params });
    expect(out.provider).toBe("local-sharp");
    expect(out.costUsd).toBe(0);
    const meta = await sharp(Buffer.from(out.bytes)).metadata();
    expect(meta.format).toBe("jpeg");
    expect(meta.width).toBe(64);
    expect(meta.height).toBe(48);
  });

  it("crops to the normalized rectangle", async () => {
    const img = await solid(100, 100, { r: 10, g: 20, b: 30 });
    const op = validateOp({ op: "crop", params: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 } });
    const out = await provider.execute(op, { bytes: img, mime: "image/jpeg", params: op.params });
    const meta = await sharp(Buffer.from(out.bytes)).metadata();
    expect(meta.width).toBe(50);
    expect(meta.height).toBe(50);
  });
});

describe("makePreview", () => {
  it("downscales to at most 256px on the long edge", async () => {
    const img = await solid(1000, 500, { r: 50, g: 50, b: 50 });
    const preview = await makePreview(img, "image/jpeg");
    expect(preview).not.toBeNull();
    const meta = await sharp(Buffer.from(preview as Uint8Array)).metadata();
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(256);
  });

  it("returns null for non-image bytes", async () => {
    expect(await makePreview(new Uint8Array([1, 2, 3]), "image/jpeg")).toBeNull();
  });
});

describe("compositeMasked (mask-bounded paste-back)", () => {
  it("keeps the original outside the mask, the edit inside", async () => {
    const original = await solid(20, 20, { r: 255, g: 0, b: 0 }); // red
    const edited = await solid(20, 20, { r: 0, g: 0, b: 255 }); // blue
    // mask: left half white (apply edit), right half black (keep original)
    const whiteLeft = await sharp({
      create: { width: 10, height: 20, channels: 3, background: { r: 255, g: 255, b: 255 } },
    })
      .png()
      .toBuffer();
    const mask = new Uint8Array(
      await sharp({
        create: { width: 20, height: 20, channels: 3, background: { r: 0, g: 0, b: 0 } },
      })
        .composite([{ input: whiteLeft, left: 0, top: 0 }])
        .png()
        .toBuffer(),
    );

    const out = await compositeMasked(original, edited, mask);
    const { data, info } = await sharp(Buffer.from(out))
      .raw()
      .toBuffer({ resolveWithObject: true });
    const px = (x: number, y: number): [number, number, number] => {
      const i = (y * info.width + x) * info.channels;
      return [data[i], data[i + 1], data[i + 2]];
    };
    const left = px(3, 10);
    const right = px(17, 10);
    expect(left[2]).toBeGreaterThan(left[0]); // blue dominant on the edited (left) side
    expect(right[0]).toBeGreaterThan(right[2]); // red dominant on the kept (right) side
  });
});
