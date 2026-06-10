/**
 * "Think Like You" MCP tools -- bridge the personality backends to the /reflect,
 * /calibrate, and /dna skills so they use the DOCUMENTED logic (the gap-detection
 * formula, the scenario library, the DNA token budget) instead of improvising the
 * computation in-prompt. Without this bridge the backend modules are orphaned and
 * the skills reinvent them ad hoc. See docs/think-like-you.md (subsystems 6-8).
 *
 * Injected in-loop in both modes (daemon + CLI). The backends operate on the
 * instance owner's user_model (the personality system is single-owner by design).
 */

import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";
import { generateReflectionData } from "../memory/reflection.ts";
import {
  analyzeCalibrationGaps,
  getNextScenario,
  formatCalibrationStatus,
} from "../memory/calibration.ts";
import { compileDNA, exportDNA, formatDNAPreview } from "../memory/personality-dna.ts";

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
const fail = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });

export function buildThinkMcpServer(): McpSdkServerConfigWithInstance {
  const reflect = tool(
    "reflect",
    "Assess how well you understand the user: returns a synthesis of their decision style / values / communication, scenario-specific predictions, and low-confidence BLIND SPOTS to probe. Backs the /reflect skill -- call it instead of guessing the user's profile.",
    {},
    async () => {
      try {
        const r = await generateReflectionData();
        return ok(JSON.stringify(r, null, 2));
      } catch (e) {
        return fail(`reflect failed: ${e instanceof Error ? e.message : e}`);
      }
    },
    { annotations: { readOnlyHint: true } },
  );

  const calibrationStatus = tool(
    "calibration_status",
    "Show calibration coverage: per-domain gaps in the user model (weighted decision patterns + values) and which domain is least understood. Backs /calibrate status.",
    {},
    async () => {
      try {
        const status = await analyzeCalibrationGaps();
        return ok(formatCalibrationStatus(status));
      } catch (e) {
        return fail(`calibration_status failed: ${e instanceof Error ? e.message : e}`);
      }
    },
    { annotations: { readOnlyHint: true } },
  );

  const calibrationNext = tool(
    "calibration_next_scenario",
    "Return the next calibration scenario (a realistic dilemma + follow-up probes) targeting the user's biggest model gap. Backs /calibrate. Pass completedIds to skip scenarios already presented this session; returns a note when coverage is sufficient.",
    {
      completedIds: z
        .array(z.string())
        .optional()
        .describe("scenario ids already presented this session"),
    },
    async (args) => {
      try {
        const s = await getNextScenario(args.completedIds);
        return ok(
          s ? JSON.stringify(s, null, 2) : "No further scenarios -- model coverage is sufficient.",
        );
      } catch (e) {
        return fail(`calibration_next_scenario failed: ${e instanceof Error ? e.message : e}`);
      }
    },
    { annotations: { readOnlyHint: true } },
  );

  const personalityDna = tool(
    "personality_dna",
    "Compile the user's portable Personality DNA: a compact (~2000-token) identity -- top decision patterns, values, style genome, and exemplar fingerprints. Returns a preview; pass export=true for the full portable document. Backs /dna.",
    {
      export: z
        .boolean()
        .optional()
        .describe("include the full exportable DNA document, not just the preview"),
    },
    async (args) => {
      try {
        const result = await compileDNA();
        const preview = formatDNAPreview(result);
        if (!args.export) return ok(preview);
        const doc = await exportDNA(result.dna);
        return ok(`${preview}\n\n---\n\n${doc}`);
      } catch (e) {
        return fail(`personality_dna failed: ${e instanceof Error ? e.message : e}`);
      }
    },
    { annotations: { readOnlyHint: true } },
  );

  return createSdkMcpServer({
    name: "nomos-think",
    version: "1.0.0",
    tools: [reflect, calibrationStatus, calibrationNext, personalityDna],
  });
}
