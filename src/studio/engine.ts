/**
 * Studio engine: the capability router. One `edit()` entry turns a requested op
 * into a persisted, executed edit:
 *
 *   validate op -> load asset -> consent gate (generative only) -> append to the
 *   chain (OCC + idempotency) -> resolve input bytes -> run the provider -> the
 *   identity gate (face-risk ops) -> persist output + ~256px preview -> record.
 *
 * Providers, the object store, the identity gate, the consent check, and the
 * preview maker are all injected, so the engine is testable without sharp, the
 * Google SDK, a DB, or a bucket. Real providers (local-sharp, gemini) and the
 * preview maker land alongside this. See the design doc sections 3 + 7.
 */

import { createLogger } from "../lib/logger.ts";
import type { TenantContext } from "../auth/tenant-context.ts";
import { getObjectStore, type ObjectStore, objectKey } from "../storage/object-store.ts";
import {
  appendEdit,
  confirmAsset,
  getAsset,
  getEdit,
  markEditDone,
  markEditFailed,
  markEditRunning,
  type StudioAsset,
  StudioAssetNotFoundError,
  type StudioEdit,
} from "./assets.ts";
import { ConsentRequiredError, isCloudAIEnabled } from "./consent.ts";
import { assertIdentityPreserved } from "./identity-gate.ts";
import { OP_META, type StudioOp, type StudioOpName, validateOp } from "./ops.ts";

const log = createLogger("studio-engine");

export interface ProviderInput {
  bytes: Uint8Array;
  mime: string;
  params: Record<string, unknown>;
  /** Device/tap mask for localized ops (mask-bounded paste-back happens in the provider). */
  maskBytes?: Uint8Array | null;
}

export interface ProviderOutput {
  bytes: Uint8Array;
  mime: string;
  costUsd?: number;
  provider: string;
}

export interface StudioProvider {
  readonly name: string;
  /** deterministic = pod CPU / on-device (free, never gated); generative = cloud (consent-gated). */
  readonly kind: "deterministic" | "generative";
  supports(op: StudioOpName): boolean;
  execute(op: StudioOp, input: ProviderInput): Promise<ProviderOutput>;
}

export class NoProviderError extends Error {
  constructor(public readonly op: string) {
    super(`No studio provider supports op: ${op}`);
    this.name = "NoProviderError";
  }
}

export interface StudioEngineDeps {
  providers: StudioProvider[];
  store?: ObjectStore;
  /** Defaults to the config-backed org-level toggle. */
  isCloudAIEnabled?: () => Promise<boolean>;
  /** Defaults to the process identity gate. */
  identityGate?: typeof assertIdentityPreserved;
  identityThreshold?: number;
  /** ~256px preview maker (sharp). When absent, previews are skipped. */
  makePreview?: (bytes: Uint8Array, mime: string) => Promise<Uint8Array | null>;
}

export interface EditRequest {
  assetId: string;
  op: { op: string; params?: unknown };
  parentEditId: string | null;
  idempotencyKey: string;
  /** Object key of a device/tap mask already uploaded for a localized op. */
  maskKey?: string | null;
  /** Inline output bytes for a `deviceRender` op (the on-device render). Ignored for any other op. */
  inlineInputBytes?: Uint8Array | null;
  /** Mime of `inlineInputBytes` (defaults to the asset mime). */
  inlineInputMime?: string;
}

function extFor(mime: string): string {
  if (mime === "image/png") return "png";
  if (mime === "image/heic" || mime === "image/heif") return "heic";
  if (mime === "image/webp") return "webp";
  return "jpg";
}

export class StudioEngine {
  private readonly providers: StudioProvider[];
  private readonly store: ObjectStore;
  private readonly isCloudAIEnabledFn: () => Promise<boolean>;
  private readonly identityGate: typeof assertIdentityPreserved;
  private readonly identityThreshold?: number;
  private readonly makePreview?: (bytes: Uint8Array, mime: string) => Promise<Uint8Array | null>;

  constructor(deps: StudioEngineDeps) {
    this.providers = deps.providers;
    this.store = deps.store ?? getObjectStore();
    this.isCloudAIEnabledFn = deps.isCloudAIEnabled ?? isCloudAIEnabled;
    this.identityGate = deps.identityGate ?? assertIdentityPreserved;
    this.identityThreshold = deps.identityThreshold;
    this.makePreview = deps.makePreview;
  }

  private resolveProvider(op: StudioOpName): StudioProvider {
    const provider = this.providers.find((p) => p.supports(op));
    if (!provider) throw new NoProviderError(op);
    return provider;
  }

  /** The input image for an edit is its parent's output, else the original. */
  private async resolveInputKey(
    ctx: TenantContext,
    asset: StudioAsset,
    parentEditId: string | null,
  ): Promise<string> {
    if (!parentEditId) return asset.objectKey;
    const parent = await getEdit(ctx, parentEditId);
    return parent?.outputKey ?? asset.objectKey;
  }

  /**
   * Execute one edit end to end. Entry symbol for the feature manifest.
   */
  async edit(ctx: TenantContext, req: EditRequest): Promise<StudioEdit> {
    const op = validateOp(req.op);
    const meta = OP_META[op.op];

    const asset = await getAsset(ctx, req.assetId);
    if (!asset) throw new StudioAssetNotFoundError(req.assetId);

    // An edit request implies the upload completed: confirm the asset out of
    // `pending` so __studio_gc__ never reaps the original of an in-use asset
    // (the conversational/MCP path has no other confirm step).
    if (asset.status === "pending") await confirmAsset(ctx, asset.id);

    // Resolve the provider before the consent gate, so consent keys off the
    // provider that will ACTUALLY run, not the op's declared kind (which can be
    // wrong, e.g. a "deterministic" op that only a cloud provider supports).
    const provider = this.resolveProvider(op.op);
    if (provider.kind === "generative" && !(await this.isCloudAIEnabledFn())) {
      throw new ConsentRequiredError();
    }

    const inputKey = await this.resolveInputKey(ctx, asset, req.parentEditId);

    // Append to the chain (OCC + idempotency). An idempotent retry returns the
    // existing row and must NOT re-execute or re-charge, whatever its status.
    const { edit, created } = await appendEdit(ctx, {
      assetId: req.assetId,
      parentEditId: req.parentEditId,
      idempotencyKey: req.idempotencyKey,
      op,
      provider: provider.name,
      inputKey,
    });
    if (!created) return edit;

    await markEditRunning(ctx, edit.id, provider.name);
    try {
      // For `deviceRender` the client ships the rendered pixels inline; every other
      // op derives its input from the chain. Inline bytes are NEVER honored for
      // another op (no source-bypass). The chain's source is still loaded when the
      // identity gate needs an original-vs-result comparison.
      const useInline = op.op === "deviceRender";
      if (useInline && (!req.inlineInputBytes || req.inlineInputBytes.length === 0)) {
        throw new Error("deviceRender requires input_image bytes");
      }
      const inlineBytes = useInline ? req.inlineInputBytes! : null;
      const needSource = inlineBytes == null || meta.identityRisk !== "none";
      const sourceBytes = needSource ? await this.store.get(inputKey) : new Uint8Array();
      const providerBytes = inlineBytes ?? sourceBytes;
      const providerMime = inlineBytes ? (req.inlineInputMime ?? asset.mime) : asset.mime;
      const maskBytes = req.maskKey ? await this.store.get(req.maskKey) : null;

      const out = await provider.execute(op, {
        bytes: providerBytes,
        mime: providerMime,
        params: op.params,
        maskBytes,
      });

      // Identity gate for face-risk ops (skips when no embedder is configured).
      let identityScore: number | null = null;
      if (meta.identityRisk !== "none") {
        const result = await this.identityGate(sourceBytes, out.bytes, {
          threshold: this.identityThreshold,
        });
        identityScore = result.score;
      }

      const ext = extFor(out.mime);
      const outputKey = objectKey("studio", asset.id, `${edit.id}.${ext}`);
      await this.store.put(outputKey, out.bytes, out.mime);

      let previewKey: string | null = null;
      if (this.makePreview) {
        const preview = await this.makePreview(out.bytes, out.mime);
        if (preview) {
          previewKey = objectKey("studio", asset.id, `${edit.id}.preview.jpg`);
          await this.store.put(previewKey, preview, "image/jpeg");
        }
      }

      const done = await markEditDone(ctx, edit.id, {
        outputKey,
        previewKey,
        costUsd: out.costUsd ?? 0,
        identityScore,
      });
      return done ?? edit;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn({ editId: edit.id, op: op.op, err: message }, "studio edit failed");
      await markEditFailed(ctx, edit.id, message);
      throw err;
    }
  }
}
