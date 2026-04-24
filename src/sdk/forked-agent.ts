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

import { runSession, type RunSessionParams } from "./session.ts";
import { getCostTracker } from "./cost-tracker.ts";

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
}

export interface ForkedAgentResult {
  /** The text output from the subagent. */
  text: string;
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

  console.log(`[forked-agent] Starting ${label} (model: ${model})...`);

  const params: RunSessionParams = {
    prompt: options.prompt,
    model,
    systemPromptAppend: options.systemPromptAppend,
    permissionMode: "bypassPermissions",
    maxTurns: options.maxTurns ?? DEFAULT_FORK_MAX_TURNS,
    stderr: (data: string) => {
      const trimmed = data.trim();
      if (trimmed) console.error(`[forked-agent:stderr:${label}] ${trimmed}`);
    },
  };

  const sdkQuery = runSession(params);

  let fullText = "";
  let totalCostUsd = 0;
  let inputTokens = 0;
  let outputTokens = 0;

  for await (const msg of sdkQuery) {
    if (options.signal?.aborted) {
      break;
    }

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

      for (const block of msg.result) {
        if (block.type === "text") {
          fullText += block.text;
        }
      }
    }
  }

  const durationMs = Date.now() - start;

  // Track cost in the global tracker
  if (totalCostUsd > 0) {
    getCostTracker().addFromSdkResult(
      totalCostUsd,
      { input_tokens: inputTokens, output_tokens: outputTokens },
      model,
    );
  }

  console.log(
    `[forked-agent] ${label} complete (${durationMs}ms, ${fullText.length} chars, $${totalCostUsd.toFixed(4)})`,
  );

  return {
    text: fullText,
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
