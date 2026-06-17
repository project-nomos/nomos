import { afterEach, describe, expect, it } from "vitest";
import { createOnnxFaceEmbedder, installServerFaceEmbedder } from "./face-embedder.ts";

describe("server face embedder (optional, graceful)", () => {
  const prev = { ...process.env };
  afterEach(() => {
    process.env = { ...prev };
  });

  it("createOnnxFaceEmbedder returns null when onnxruntime is unavailable", async () => {
    // onnxruntime-node is an optional dep and is not installed in this env.
    expect(await createOnnxFaceEmbedder({ modelPath: "/nonexistent/model.onnx" })).toBeNull();
  });

  it("installServerFaceEmbedder is a no-op without NOMOS_FACE_MODEL_PATH", async () => {
    delete process.env.NOMOS_FACE_MODEL_PATH;
    expect(await installServerFaceEmbedder()).toBe(false);
  });

  it("installServerFaceEmbedder returns false when the model cannot load", async () => {
    process.env.NOMOS_FACE_MODEL_PATH = "/nonexistent/model.onnx";
    expect(await installServerFaceEmbedder()).toBe(false);
  });
});
