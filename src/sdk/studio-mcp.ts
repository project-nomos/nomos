/**
 * In-process MCP server exposing Nomos Studio as agent tools (the vault-mcp
 * pattern: built per turn, scoped to the requesting user). Lets the conversational
 * editor run inside a normal MobileApi.Chat turn: the user describes an edit, the
 * agent calls a studio tool, the engine executes + records it, the app fetches the
 * result. Hosted-only; injected when FEATURES.studio() is on.
 *
 * Tools:
 *   studio_edit     - natural-language instruction edit (cloud; needs consent)
 *   studio_adjust   - tonal sliders (exposure/contrast/saturation/temperature; free)
 *   studio_cutout   - remove the background
 *   studio_upscale  - increase resolution/sharpness
 *   studio_restore  - restore an old/damaged photo
 *   studio_history  - list the op chain
 */

import { randomUUID } from "node:crypto";
import {
  createSdkMcpServer,
  type McpSdkServerConfigWithInstance,
  tool,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";
import type { TenantContext } from "../auth/tenant-context.ts";
import { createLogger } from "../lib/logger.ts";
import { getAsset, listEdits } from "../studio/assets.ts";
import { ConsentRequiredError } from "../studio/consent.ts";
import { StudioEngine, type StudioProvider } from "../studio/engine.ts";
import {
  createGoogleGenAIImageClient,
  GeminiImageProvider,
} from "../studio/providers/gemini-image.ts";
import { LocalSharpProvider, makePreview } from "../studio/providers/local-sharp.ts";

const log = createLogger("studio-mcp");

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
const fail = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });

function tenantFor(userId: string): TenantContext {
  return { orgId: process.env.NOMOS_ORG_ID ?? "local", userId };
}

/** Wire the engine with the deterministic provider always, the GCP provider when configured. */
export function buildStudioEngine(): StudioEngine {
  const providers: StudioProvider[] = [new LocalSharpProvider()];
  if (process.env.GEMINI_API_KEY || process.env.GOOGLE_CLOUD_PROJECT) {
    try {
      providers.push(
        new GeminiImageProvider(createGoogleGenAIImageClient(), {
          name:
            process.env.NOMOS_STUDIO_PROVIDER ??
            (process.env.GOOGLE_CLOUD_PROJECT ? "vertex" : "gemini"),
        }),
      );
    } catch (err) {
      log.warn({ err }, "studio: GCP image provider unavailable; generative ops disabled");
    }
  }
  return new StudioEngine({ providers, makePreview });
}

async function applyOp(
  engine: StudioEngine,
  userId: string,
  assetId: string,
  op: { op: string; params?: unknown },
) {
  const ctx = tenantFor(userId);
  const asset = await getAsset(ctx, assetId);
  if (!asset) return fail(`No photo with id ${assetId}.`);
  try {
    const edit = await engine.edit(ctx, {
      assetId,
      op,
      parentEditId: asset.headEditId,
      idempotencyKey: randomUUID(),
    });
    const cost = edit.costUsd ? ` (cost $${edit.costUsd.toFixed(3)})` : "";
    return ok(`Applied ${op.op}. Edit ${edit.id} is ${edit.status}${cost}.`);
  } catch (err) {
    if (err instanceof ConsentRequiredError) {
      return fail(
        "Cloud edits are turned off. Ask the user to enable Cloud AI in Studio settings, then try again.",
      );
    }
    return fail(`${op.op} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Build the per-user Studio MCP server. Manifest entry symbol. */
export function buildStudioMcpServer(userId: string): McpSdkServerConfigWithInstance {
  const engine = buildStudioEngine();

  const studioEdit = tool(
    "studio_edit",
    "Apply a natural-language edit to the user's photo (e.g. 'remove the person in the background', 'warm up the lighting', 'make the sky bluer'). Cloud edit, requires Cloud AI consent.",
    { asset_id: z.string().describe("The Studio asset id"), instruction: z.string() },
    async (a) =>
      applyOp(engine, userId, a.asset_id, {
        op: "editSemantic",
        params: { instruction: a.instruction },
      }),
  );

  const studioAdjust = tool(
    "studio_adjust",
    "Adjust the photo's tone with sliders in the range -1..1 (exposure, contrast, saturation, temperature). Free and instant, no cloud call.",
    {
      asset_id: z.string(),
      exposure: z.number().min(-1).max(1).optional(),
      contrast: z.number().min(-1).max(1).optional(),
      saturation: z.number().min(-1).max(1).optional(),
      temperature: z.number().min(-1).max(1).optional(),
    },
    async (a) =>
      applyOp(engine, userId, a.asset_id, {
        op: "adjust",
        params: {
          exposure: a.exposure,
          contrast: a.contrast,
          saturation: a.saturation,
          temperature: a.temperature,
        },
      }),
  );

  const studioCutout = tool(
    "studio_cutout",
    "Remove the background from the photo, keeping the main subject.",
    { asset_id: z.string() },
    async (a) => applyOp(engine, userId, a.asset_id, { op: "cutout", params: {} }),
  );

  const studioUpscale = tool(
    "studio_upscale",
    "Increase the photo's resolution and sharpness (2x or 4x).",
    { asset_id: z.string(), factor: z.union([z.literal(2), z.literal(4)]).optional() },
    async (a) =>
      applyOp(engine, userId, a.asset_id, {
        op: "upscale",
        params: a.factor ? { factor: a.factor } : {},
      }),
  );

  const studioRestore = tool(
    "studio_restore",
    "Restore an old or damaged photo: repair scratches, denoise, recover color.",
    { asset_id: z.string() },
    async (a) => applyOp(engine, userId, a.asset_id, { op: "restore", params: {} }),
  );

  const studioHistory = tool(
    "studio_history",
    "List the edit history (op chain) of a photo, oldest first.",
    { asset_id: z.string() },
    async (a) => {
      const edits = await listEdits(tenantFor(userId), a.asset_id);
      if (edits.length === 0) return ok("No edits yet on this photo.");
      const lines = edits.map(
        (e, i) => `${i + 1}. ${e.op} [${e.status}]${e.costUsd ? ` $${e.costUsd.toFixed(3)}` : ""}`,
      );
      return ok(lines.join("\n"));
    },
    { annotations: { readOnlyHint: true } },
  );

  return createSdkMcpServer({
    name: "nomos-studio",
    version: "1.0.0",
    tools: [studioEdit, studioAdjust, studioCutout, studioUpscale, studioRestore, studioHistory],
  });
}
