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

/** Maximum turns for a forked agent. Forks are single-answer by default; a
 *  tool-using fork overrides this (e.g. magic-docs). */
const DEFAULT_FORK_MAX_TURNS = 2;

export interface ForkedAgentOptions {
  /** The prompt for the subagent. */
  prompt: string;
  /** Model to use (default: haiku for cost efficiency). */
  model?: string;
  /** System prompt append. */
  systemPromptAppend?: string;
  /** Maximum turns (default: 2). */
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
   * Tool allowlist. Forks DEFAULT to no tools (`[]`) — a pure-reasoning fork
   * answers from its prompt alone, and a thinking model can't burn its turns
   * investigating. Pass an explicit list to scope tools, or set `fullTools` to
   * inherit the whole toolset.
   */
  allowedTools?: string[];
  /**
   * Opt into the full built-in toolset instead of the no-tools default. Only for
   * genuinely tool-using forks (e.g. reading source files to refresh a doc).
   * Ignored when `allowedTools` is set explicitly.
   */
  fullTools?: boolean;
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

  // Tools: forks default to NO tools (pure reasoning). Opt in with an explicit
  // allowlist, or `fullTools` to inherit the whole built-in toolset (undefined →
  // the SDK keeps them all). This makes the safe shape the default; a new caller
  // can't accidentally inherit the full toolset.
  const allowedTools = options.allowedTools ?? (options.fullTools ? undefined : []);

  // Structured output: convert the zod schema to JSON Schema for the SDK. A schema
  // with .transform()/.pipe() cannot be represented as JSON Schema (z.toJSONSchema
  // throws). Degrade gracefully to the text path rather than crashing a
  // fire-and-forget fork — the caller's safeParse still applies any transforms.
  let outputFormat: { type: "json_schema"; schema: Record<string, unknown> } | undefined;
  if (options.outputSchema) {
    try {
      outputFormat = {
        type: "json_schema" as const,
        schema: z.toJSONSchema(options.outputSchema) as Record<string, unknown>,
      };
    } catch (err) {
      log.warn(
        { label, err: err instanceof Error ? err.message : err },
        "outputSchema not representable as JSON Schema — running fork without SDK-enforced structured output",
      );
    }
  }

  const params: RunSessionParams = {
    prompt: options.prompt,
    model,
    systemPromptAppend: options.systemPromptAppend,
    permissionMode: "bypassPermissions",
    maxTurns: options.maxTurns ?? DEFAULT_FORK_MAX_TURNS,
    useSubscription,
    // Forks are one-shot: their transcripts are never resumed and they never
    // rewind files, so skip session persistence + file checkpointing (D.4 +
    // Appendix). Pure overhead reduction; no behavior change.
    persistSession: false,
    enableFileCheckpointing: false,
    hooks: buildSdkHooks({ sessionKey: `fork:${label}`, approvalPolicy }),
    ...(options.thinking ? { thinking: options.thinking } : {}),
    ...(options.effort ? { effort: options.effort } : {}),
    ...(allowedTools !== undefined ? { allowedTools } : {}),
    // Phase C — when a schema is supplied and representable, force SDK-validated
    // structured output (computed above with a graceful fallback).
    ...(outputFormat ? { outputFormat } : {}),
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
