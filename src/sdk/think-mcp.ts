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
import {
  sampleRealMessages,
  calculateFidelityScore,
  type TwinTestPair,
} from "../memory/twin-test.ts";
import { recordFidelityScore, getFidelityHistory } from "../db/fidelity-scores.ts";
import { resolveMemoryUserId } from "../auth/tenant-context.ts";

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

  const twinSample = tool(
    "twin_test_sample",
    "Pull N diverse real user messages (each with its conversational context) for a twin test. Generate a clone reply for each, then judge which is real. Backs /twin-test.",
    {
      count: z
        .number()
        .int()
        .min(1)
        .max(10)
        .optional()
        .describe("how many message pairs (default 5)"),
    },
    async (args) => {
      try {
        const pairs = await sampleRealMessages(args.count ?? 5);
        if (pairs.length === 0)
          return ok("No real messages available yet to sample for a twin test.");
        return ok(
          JSON.stringify(
            pairs.map((p) => ({
              id: p.id,
              context: p.context,
              realMessage: p.realMessage,
              platform: p.platform,
            })),
            null,
            2,
          ),
        );
      } catch (e) {
        return fail(`twin_test_sample failed: ${e instanceof Error ? e.message : e}`);
      }
    },
    { annotations: { readOnlyHint: true } },
  );

  const twinRecord = tool(
    "twin_test_record",
    "Record a twin-test run. Pass per-pair `results`: true = the discriminator correctly spotted the REAL message, false = it was fooled. Computes the fidelity score (fraction fooled) and stores it for the trend. Backs /twin-test scoring.",
    {
      results: z
        .array(z.boolean())
        .min(1)
        .describe("per pair: did the discriminator correctly identify the REAL message?"),
    },
    async (args) => {
      try {
        const owner = resolveMemoryUserId(undefined);
        const pairs = args.results.map((c) => ({ discriminatorCorrect: c }) as TwinTestPair);
        const score = calculateFidelityScore(pairs);
        const fooled = args.results.filter((c) => !c).length;
        const prev = (await getFidelityHistory(owner, 1))[0]?.score;
        await recordFidelityScore({ userId: owner, score, pairs: args.results.length, fooled });
        const trend =
          prev === undefined
            ? "first recorded run"
            : score > prev
              ? `up from ${(prev * 100).toFixed(0)}%`
              : score < prev
                ? `down from ${(prev * 100).toFixed(0)}%`
                : "unchanged";
        return ok(
          `Fidelity ${(score * 100).toFixed(0)}% (${fooled}/${args.results.length} fooled) -- ${trend}.`,
        );
      } catch (e) {
        return fail(`twin_test_record failed: ${e instanceof Error ? e.message : e}`);
      }
    },
  );

  const twinHistory = tool(
    "twin_test_history",
    "Show the fidelity score history (most recent first) so you can report the trend over time. Backs /twin-test score.",
    {},
    async () => {
      try {
        const hist = await getFidelityHistory(resolveMemoryUserId(undefined));
        if (hist.length === 0) return ok("No twin-test runs recorded yet.");
        return ok(
          hist
            .map(
              (h) =>
                `${h.createdAt.toISOString().slice(0, 10)}: ${(h.score * 100).toFixed(0)}% (${h.fooled}/${h.pairs} fooled)`,
            )
            .join("\n"),
        );
      } catch (e) {
        return fail(`twin_test_history failed: ${e instanceof Error ? e.message : e}`);
      }
    },
    { annotations: { readOnlyHint: true } },
  );

  return createSdkMcpServer({
    name: "nomos-think",
    version: "1.0.0",
    tools: [
      reflect,
      calibrationStatus,
      calibrationNext,
      personalityDna,
      twinSample,
      twinRecord,
      twinHistory,
    ],
  });
}
