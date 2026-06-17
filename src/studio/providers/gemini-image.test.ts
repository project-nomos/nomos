import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateOp } from "../ops.ts";

// Mock the SDK so the real client can be exercised without creds or a network.
const { generateContent } = vi.hoisted(() => ({ generateContent: vi.fn() }));
vi.mock("@google/genai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@google/genai")>();
  // A regular function (not an arrow) so `new GoogleGenAI(...)` is constructable;
  // the returned object becomes the instance.
  return {
    ...actual,
    GoogleGenAI: vi.fn(function () {
      return { models: { generateContent } };
    }),
  };
});

import {
  createGoogleGenAIImageClient,
  type GenAIImageClient,
  GeminiImageProvider,
} from "./gemini-image.ts";

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
    // The instruction is sent, with the universal quality guard appended to every prompt.
    const sent = vi.mocked(client.editImage).mock.calls[0][0].prompt;
    expect(sent).toContain("warm it up");
    expect(sent).toMatch(/sharp|detail|do not soften|don't soften/i);
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

describe("createGoogleGenAIImageClient (real client over the mocked SDK)", () => {
  const SAVED = [
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "NOMOS_STUDIO_PROVIDER",
    "GOOGLE_CLOUD_PROJECT",
  ];
  const prev: Record<string, string | undefined> = {};

  beforeEach(() => {
    generateContent.mockReset();
    for (const k of SAVED) {
      prev[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of SAVED) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  });

  function okImage() {
    generateContent.mockResolvedValue({
      candidates: [
        { content: { parts: [{ inlineData: { data: "QUJD", mimeType: "image/png" } }] } },
      ],
    });
  }
  function sentCategories(): string[] {
    const arg = generateContent.mock.calls[0][0] as {
      config?: { safetySettings?: { category: string; threshold: string }[] };
    };
    return (arg.config?.safetySettings ?? []).map((s) => s.category);
  }
  function sentThresholds(): string[] {
    const arg = generateContent.mock.calls[0][0] as {
      config?: { safetySettings?: { category: string; threshold: string }[] };
    };
    return (arg.config?.safetySettings ?? []).map((s) => s.threshold);
  }

  it("Vertex surface: relaxes text AND image harm categories", async () => {
    process.env.GOOGLE_CLOUD_PROJECT = "test-project";
    process.env.NOMOS_STUDIO_PROVIDER = "vertex";
    okImage();
    const out = await createGoogleGenAIImageClient({ model: "m" }).editImage({
      imageBase64: "x",
      mimeType: "image/jpeg",
      prompt: "warm it",
    });

    expect(out).toEqual({ base64: "QUJD", mimeType: "image/png" });
    const cats = sentCategories();
    // The IMAGE_* categories govern the IMAGE_SAFETY finish reason — Vertex only.
    expect(cats).toContain("HARM_CATEGORY_IMAGE_SEXUALLY_EXPLICIT");
    expect(cats).toContain("HARM_CATEGORY_SEXUALLY_EXPLICIT");
    expect(cats).toHaveLength(8);
    expect(sentThresholds().every((t) => t === "BLOCK_NONE")).toBe(true);
  });

  it("Gemini API surface: text categories only (image categories 400 there)", async () => {
    process.env.GEMINI_API_KEY = "test-key"; // forces the API-key surface
    okImage();
    await createGoogleGenAIImageClient({ model: "m" }).editImage({
      imageBase64: "x",
      mimeType: "image/jpeg",
      prompt: "warm it",
    });

    const cats = sentCategories();
    expect(cats).toContain("HARM_CATEGORY_SEXUALLY_EXPLICIT");
    expect(cats.some((c) => c.startsWith("HARM_CATEGORY_IMAGE_"))).toBe(false);
    expect(cats).toHaveLength(4);
  });

  it("surfaces a safety finish reason as a human-readable refusal", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    generateContent.mockResolvedValue({
      candidates: [{ finishReason: "IMAGE_SAFETY", content: { parts: [] } }],
    });
    await expect(
      createGoogleGenAIImageClient({ model: "m" }).editImage({
        imageBase64: "x",
        mimeType: "image/jpeg",
        prompt: "p",
      }),
    ).rejects.toThrow(/content-safety filter/i);
  });
});
