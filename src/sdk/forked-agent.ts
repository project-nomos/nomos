/**
 * Forked agent — spawn isolated subagents for background work.
 *
 * Enables spawning lightweight agent queries for side tasks
 * (summaries, classifications, suggestions) without blocking
 * the main conversation loop. Tracks usage across all forks
 * for accurate cost accounting.
 *
 * Adapted from Claude Code's forkedAgent.ts.
 */

import { z } from "zod";
import { runSession, type RunSessionParams } from "./session.ts";
import { buildSdkHooks } from "../hooks/sdk-adapter.ts";
import type { ApprovalPolicy } from "../security/tool-approval.ts";
import { withRetry } from "./retry.ts";
import { getCostTracker } from "./cost-tracker.ts";
import { createLogger } from "../lib/logger.ts";

const log = createLogger("forked-agent");

/** Default model for background subagents (cheap + fast). */
const DEFAULT_FORK_MODEL = "claude-haiku-4-5";

/** Maximum turns for a forked agent (keep it short). */
const DEFAULT_FORK_MAX_TURNS = 5;

export interface ForkedAgentOptions {
  /** The prompt for the subagent. */
  prompt: string;
  /** Model to use (default: haiku for cost efficiency). */
  model?: string;
  /** System prompt append. */
  systemPromptAppend?: string;
  /** Maximum turns (default: 5). */
  maxTurns?: number;
  /** Label for tracking (e.g., "summary", "classifier"). */
  label?: string;
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
  /** Thinking config (e.g. { type: "adaptive" } for Opus 4.6+ extended thinking). */
  thinking?: RunSessionParams["thinking"];
  /** Reasoning effort ('xhigh' is the ultracode level; default 'high'). */
  effort?: RunSessionParams["effort"];
  /**
   * Tool allowlist. Pass `[]` for a pure-reasoning fork that must answer from its
   * prompt alone -- without this the fork inherits the full toolset and a
   * thinking model may spend its turns investigating instead of answering.
   */
  allowedTools?: string[];
  /**
   * Force structured JSON output validated against this zod schema (Phase C).
   * Converted to JSON Schema and passed as the SDK `outputFormat`; the validated
   * object is returned on `ForkedAgentResult.structuredOutput`. Prefer this over
   * regex + JSON.parse on `text` -- the SDK validates and bounded-retries.
   */
  outputSchema?: z.ZodType;
}

export interface ForkedAgentResult {
  /** The text output from the subagent. */
  text: string;
  /** Validated structured output when `outputSchema` was supplied (Phase C). */
  structuredOutput?: unknown;
  /** Cost of this fork in USD. */
  costUsd: number;
  /** Duration in milliseconds. */
  durationMs: number;
  /** Token usage. */
  usage: { inputTokens: number; outputTokens: number };
}

/**
 * Run a forked agent query — a lightweight, isolated subagent.
 *
 * Use this for background tasks like:
 * - Classifying query complexity for smart routing
 * - Generating conversation summaries
 * - Extracting knowledge from transcripts
 * - Running side questions that shouldn't pollute the main context
 *
 * The fork runs with `bypassPermissions` and minimal turns.
 */
export async function runForkedAgent(options: ForkedAgentOptions): Promise<ForkedAgentResult> {
  const model = options.model ?? DEFAULT_FORK_MODEL;
  const label = options.label ?? "fork";
  const start = Date.now();

  log.info({ label, model }, "Starting fork");

  // Check if subscription mode is enabled (reads env at call time)
  const useSubscription = process.env.NOMOS_USE_SUBSCRIPTION === "true";
  // Owner/default approval policy: forks run bypassPermissions, so apply the
  // same block_critical PreToolUse gate as the main path (reads env at call time).
  const approvalPolicy = (process.env.TOOL_APPROVAL_POLICY as ApprovalPolicy) ?? "block_critical";

  const params: RunSessionParams = {
    prompt: options.prompt,
    model,
    systemPromptAppend: options.systemPromptAppend,
    permissionMode: "bypassPermissions",
    maxTurns: options.maxTurns ?? DEFAULT_FORK_MAX_TURNS,
    useSubscription,
    hooks: buildSdkHooks({ sessionKey: `fork:${label}`, approvalPolicy }),
    ...(options.thinking ? { thinking: options.thinking } : {}),
    ...(options.effort ? { effort: options.effort } : {}),
    ...(options.allowedTools !== undefined ? { allowedTools: options.allowedTools } : {}),
    // Phase C — when a schema is supplied, force SDK-validated structured output.
    ...(options.outputSchema
      ? {
          outputFormat: {
            type: "json_schema" as const,
            schema: z.toJSONSchema(options.outputSchema) as Record<string, unknown>,
          },
        }
      : {}),
    stderr: (data: string) => {
      const trimmed = data.trim();
      if (trimmed) log.error({ label, stream: "stderr" }, trimmed);
    },
  };

  let fullText = "";
  let structuredOutput: unknown;
  let totalCostUsd = 0;
  let inputTokens = 0;
  let outputTokens = 0;

  // Retry the whole build-and-drain on transient (429/529) errors -- the SDK
  // surfaces those during generator iteration, not from runSession() itself.
  // Reset the accumulators at the top of each attempt so a partial failed
  // attempt never leaks into the next one (and cost is tallied only once, after
  // the loop, from the final successful attempt).
  await withRetry(
    async () => {
      fullText = "";
      structuredOutput = undefined;
      totalCostUsd = 0;
      inputTokens = 0;
      outputTokens = 0;
      const sdkQuery = runSession(params);
      for await (const msg of sdkQuery) {
        if (options.signal?.aborted) break;

        if (msg.type === "assistant") {
          for (const block of msg.message.content) {
            if (block.type === "text" && block.text) {
              if (fullText && !fullText.endsWith("\n")) fullText += "\n";
              fullText += block.text;
            }
          }
        } else if (msg.type === "result") {
          totalCostUsd = msg.total_cost_usd ?? 0;
          inputTokens = msg.usage?.input_tokens ?? 0;
          outputTokens = msg.usage?.output_tokens ?? 0;

          const so = (msg as { structured_output?: unknown }).structured_output;
          if (so !== undefined) structuredOutput = so;
          if ("result" in msg) {
            fullText += msg.result;
          }
        }
      }
    },
    {
      signal: options.signal,
      onRetry: (attempt, delayMs, err) =>
        log.warn(
          { label, attempt, delayMs, err: err instanceof Error ? err.message : err },
          `${label} retry`,
        ),
    },
  );

  const durationMs = Date.now() - start;

  // Track cost in the global tracker
  if (totalCostUsd > 0) {
    getCostTracker().addFromSdkResult(
      totalCostUsd,
      { input_tokens: inputTokens, output_tokens: outputTokens },
      model,
    );
  }

  log.info(
    { label, durationMs, chars: fullText.length, costUsd: totalCostUsd },
    `${label} complete (${durationMs}ms, ${fullText.length} chars, $${totalCostUsd.toFixed(4)})`,
  );

  return {
    text: fullText,
    structuredOutput,
    costUsd: totalCostUsd,
    durationMs,
    usage: { inputTokens, outputTokens },
  };
}

/**
 * Run multiple forked agents in parallel and collect results.
 */
export async function runParallelForks(forks: ForkedAgentOptions[]): Promise<ForkedAgentResult[]> {
  return Promise.all(forks.map(runForkedAgent));
}
