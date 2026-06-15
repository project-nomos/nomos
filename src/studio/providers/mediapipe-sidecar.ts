/**
 * Provider that runs the deterministic beauty ops on the Phase-3 Python sidecar
 * (`nomos-studio-sidecar`, FastAPI + MediaPipe + OpenCV) over localhost HTTP.
 * Registered BEFORE the Gemini provider so a reachable sidecar wins (free,
 * deterministic); when absent the op falls through to the generative fallback.
 *
 * The launcher (`sidecar-launcher.ts`) owns the process + the base URL; this
 * provider is only constructed once a URL is known. Pins the HTTP contract
 * version and fails loudly on mismatch.
 */

import sharp from "sharp";
import type { ProviderInput, ProviderOutput, StudioProvider } from "../engine.ts";
import type { StudioOp, StudioOpName } from "../ops.ts";

/** Ops the sidecar implements (v1). Must stay a subset of the op registry. */
const SIDECAR_OPS: readonly StudioOpName[] = ["retouch"];

/** HTTP contract version the daemon pins; the sidecar reports its own in /healthz. */
export const SIDECAR_CONTRACT_VERSION = "v1";

/** Reject an absurd response before decoding (~30MB decoded). */
const MAX_RESPONSE_B64 = 40 * 1024 * 1024;
const MAX_EDGE = 4096;

interface SidecarEditResponse {
  image_b64: string;
  mime?: string;
  cost_usd?: number;
  provider?: string;
}

export class SidecarProvider implements StudioProvider {
  readonly name = "mediapipe-sidecar";
  readonly kind = "deterministic" as const;

  constructor(private readonly baseUrl: string) {}

  supports(op: StudioOpName): boolean {
    return SIDECAR_OPS.includes(op);
  }

  async execute(op: StudioOp, input: ProviderInput): Promise<ProviderOutput> {
    const resp = await fetch(`${this.baseUrl}/v1/edit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        op: op.op,
        params: op.params,
        image_b64: Buffer.from(input.bytes).toString("base64"),
        mime: input.mime,
      }),
    });
    if (!resp.ok) {
      throw new Error(`studio sidecar ${op.op} failed: HTTP ${resp.status}`);
    }
    const json = (await resp.json()) as SidecarEditResponse;
    if (!json.image_b64) throw new Error(`studio sidecar ${op.op}: empty response`);
    if (json.image_b64.length > MAX_RESPONSE_B64) {
      throw new Error(`studio sidecar ${op.op}: response too large`);
    }
    // Trust boundary: Buffer.from(...,"base64") never throws on garbage, so
    // re-encode through sharp — this validates it is a real image, strips any
    // metadata, and clamps the size, mirroring the deviceRender path.
    const decoded = Buffer.from(json.image_b64, "base64");
    if (decoded.length === 0) throw new Error(`studio sidecar ${op.op}: undecodable image`);
    const safe = await sharp(decoded)
      .rotate()
      .resize(MAX_EDGE, MAX_EDGE, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 92 })
      .toBuffer();
    return {
      bytes: new Uint8Array(safe),
      mime: "image/jpeg",
      costUsd: json.cost_usd ?? 0,
      provider: this.name,
    };
  }
}
