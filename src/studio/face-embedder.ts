/**
 * Optional server-side face embedder for the identity gate. Loads an
 * operator-provided face-recognition ONNX model (NOMOS_FACE_MODEL_PATH) through
 * onnxruntime-node, lazily, and embeds a face crop. Deliberately NOT bundled: it
 * keeps the repo light, and the privacy-preferred path is the on-device check
 * reported via the identity-report RPC (recordIdentityScore). When no model is
 * configured, the gate stays a documented no-op (assertIdentityPreserved skips).
 *
 * onnxruntime-node is an optional dependency, imported by a non-literal specifier
 * so typecheck/build do not require it to be installed.
 */

import sharp from "sharp";
import { createLogger } from "../lib/logger.ts";
import { type FaceEmbedder, setFaceEmbedder } from "./identity-gate.ts";

const log = createLogger("studio-face-embedder");

interface OrtSession {
  run(feeds: Record<string, unknown>): Promise<Record<string, { data: ArrayLike<number> }>>;
  inputNames: string[];
  outputNames: string[];
}
interface OrtModule {
  InferenceSession: { create(path: string): Promise<OrtSession> };
  Tensor: new (type: string, data: Float32Array, dims: number[]) => unknown;
}

const ORT_MODULE = "onnxruntime-node";

async function loadOrt(): Promise<OrtModule | null> {
  try {
    return (await import(ORT_MODULE)) as unknown as OrtModule;
  } catch {
    log.warn("onnxruntime-node not installed; server face embedder unavailable");
    return null;
  }
}

export interface OnnxFaceEmbedderOptions {
  modelPath: string;
  /** Square model input edge in px (ArcFace-class default). */
  inputSize?: number;
}

/**
 * Build an embedder over a face-recognition ONNX model. Expects an already
 * face-cropped image (alignment/detection is the caller's / on-device job).
 * Returns null when onnxruntime or the model is unavailable.
 */
export async function createOnnxFaceEmbedder(
  opts: OnnxFaceEmbedderOptions,
): Promise<FaceEmbedder | null> {
  const ort = await loadOrt();
  if (!ort) return null;

  let session: OrtSession;
  try {
    session = await ort.InferenceSession.create(opts.modelPath);
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : err, modelPath: opts.modelPath },
      "failed to load face model",
    );
    return null;
  }

  const size = opts.inputSize ?? 112;
  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];

  return async (image: Uint8Array): Promise<number[] | null> => {
    try {
      const { data } = await sharp(Buffer.from(image))
        .resize(size, size, { fit: "cover" })
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      // RGB -> CHW float32, normalized to [-1, 1] (ArcFace-style).
      const plane = size * size;
      const chw = new Float32Array(3 * plane);
      for (let i = 0; i < plane; i++) {
        chw[i] = (data[i * 3] / 255 - 0.5) / 0.5;
        chw[plane + i] = (data[i * 3 + 1] / 255 - 0.5) / 0.5;
        chw[2 * plane + i] = (data[i * 3 + 2] / 255 - 0.5) / 0.5;
      }
      const tensor = new ort.Tensor("float32", chw, [1, 3, size, size]);
      const out = await session.run({ [inputName]: tensor });
      const emb = out[outputName]?.data;
      return emb ? Array.from(emb) : null;
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : err }, "face embed failed");
      return null;
    }
  };
}

/**
 * Install the server embedder process-wide when NOMOS_FACE_MODEL_PATH is set.
 * Returns true on success. Safe to call at boot; a no-op without the env var.
 */
export async function installServerFaceEmbedder(): Promise<boolean> {
  const modelPath = process.env.NOMOS_FACE_MODEL_PATH;
  if (!modelPath) return false;
  const inputSize = process.env.NOMOS_FACE_MODEL_INPUT
    ? Number(process.env.NOMOS_FACE_MODEL_INPUT)
    : undefined;
  const embedder = await createOnnxFaceEmbedder({ modelPath, inputSize });
  if (!embedder) return false;
  setFaceEmbedder(embedder);
  log.info({ modelPath }, "studio: server face embedder installed");
  return true;
}
