/**
 * Reasoning fork — the enforced shape for pure-reasoning classify/extract/score
 * loops that run repeatedly (per-turn extractors, per-run batch loops, cron
 * digests).
 *
 * These loops share one token-efficiency contract, and getting any part wrong
 * silently wastes tokens or (worse) writes synthetic defaults to the DB. This
 * helper makes the correct shape the ONLY shape:
 *
 *  1. STABLE instructions (the rubric + JSON-shape spec) go to `systemPromptAppend`
 *     — part of the SDK's cached system-prompt prefix, so a byte-identical block
 *     is reused across invocations within the ~5min cache TTL. The per-item
 *     DYNAMIC data goes LAST as the user `prompt`, which is never cached. Putting
 *     the rubric in the prompt (the old idiom) re-bills it uncached every call.
 *  2. `allowedTools: []` — a pure-reasoning fork must answer from its prompt, not
 *     wander into tool calls (which also burns its single turn).
 *  3. `maxTurns: 1` by default (2 for multi-step extraction) — one validated turn.
 *  4. A required `schema` → SDK-validated structured output, read back with one
 *     explicit fallback. Replaces the fragile regex + JSON.parse idiom whose
 *     silent default-on-failure poisoned DB tables with fake rows.
 *
 * `instructions` and `input` are structurally separate so a caller cannot
 * accidentally interpolate dynamic data into the cached prefix. NEVER put
 * per-item data (transcripts, samples, timestamps, ids) in `instructions`.
 */

import type { z } from "zod";
import { runForkedAgent, type ForkedAgentOptions, type ForkedAgentResult } from "./forked-agent.ts";
import { coerceJson, extractFirstJson } from "../lib/json-extract.ts";

export interface ReasoningForkOptions<T> {
  /**
   * STABLE instructions — the fixed rubric / procedure / JSON-shape spec. MUST be
   * byte-identical across invocations so the SDK caches it in the system-prompt
   * prefix. Goes to `systemPromptAppend`. NEVER put per-item dynamic data here.
   */
  instructions: string;
  /**
   * DYNAMIC per-item input — the only thing that changes between calls (the
   * transcript, the item, the samples). Goes LAST, as the user `prompt`.
   */
  input: string;
  /** Zod schema the SDK validates the model's output against (single turn). */
  schema: z.ZodType<T>;
  /** Model (default: forked-agent's haiku). */
  model?: string;
  /** Max turns (default: 1). Bump to 2 only for genuinely multi-step extraction. */
  maxTurns?: number;
  /** Tracking label (e.g. "knowledge-extraction"). */
  label: string;
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
  /** Reasoning effort override. */
  effort?: ForkedAgentOptions["effort"];
}

export interface ReasoningForkResult<T> {
  /** Validated output, or null if the fork produced nothing parseable. */
  data: T | null;
  /** Raw fork result (cost, usage, text) for the caller's accounting/logging. */
  raw: ForkedAgentResult;
}

/**
 * Run a pure-reasoning fork with the enforced token-efficient shape.
 * The instructions cache in the prefix; only `input` is billed uncached.
 */
export async function runReasoningFork<T>(
  opts: ReasoningForkOptions<T>,
): Promise<ReasoningForkResult<T>> {
  const raw = await runForkedAgent({
    prompt: opts.input,
    systemPromptAppend: opts.instructions,
    ...(opts.model ? { model: opts.model } : {}),
    maxTurns: opts.maxTurns ?? 1,
    label: opts.label,
    // Pure reasoning: no tools. Prevents a thinking model from spending its
    // (single) turn investigating instead of answering.
    allowedTools: [],
    outputSchema: opts.schema,
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.effort ? { effort: opts.effort } : {}),
  });

  return { data: coerceStructuredOutput(opts.schema, raw), raw };
}

/**
 * Validate a fork's output against `schema`, preferring the SDK-validated
 * `structuredOutput` and falling back once to the first BALANCED JSON value in
 * the text (forked-agent returns its text DUPLICATED + ```json-fenced, so a
 * greedy first-{ to last-} match would splice the two copies into invalid JSON).
 * Returns null on failure — callers supply their own typed default. This is the
 * single validated path that replaces every ad-hoc regex + JSON.parse in the
 * loop cluster.
 */
export function coerceStructuredOutput<T>(schema: z.ZodType<T>, raw: ForkedAgentResult): T | null {
  // Only trust `structuredOutput` when the SDK actually populated it. It is
  // commonly `undefined` on the subscription/fork path — and a schema with a
  // ROOT-level `.default()` (e.g. `z.array(...).default([])`) would then make
  // `safeParse(undefined)` SUCCEED with the default, masking the real answer the
  // model emitted as text and never trying the fallback. That silently returned
  // `[]` and zeroed wiki compilation. So skip the direct parse when it's absent.
  if (raw.structuredOutput !== undefined && raw.structuredOutput !== null) {
    const direct = schema.safeParse(coerceJson(raw.structuredOutput));
    if (direct.success) return direct.data;
  }

  const fallback = schema.safeParse(extractFirstJson(raw.text));
  return fallback.success ? fallback.data : null;
}
