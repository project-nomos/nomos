/**
 * Per-turn context assembly for the main agent's cache-stable prefix (#0).
 *
 * The SDK caches the request prefix in the order tools → system → messages, and
 * treats the whole system block as ONE atomic cache unit. So per-turn-VOLATILE
 * context (Theory-of-Mind read, memory digest, elapsed anchor, mood, wiki) must
 * NOT live in `systemPromptAppend`: mutating a single byte of the system block
 * every turn re-bills the tool schemas AND the entire resumed conversation
 * history — the dominant cost on the main agent.
 *
 * buildTurnContext keeps the STABLE append untouched (byte-identical across a
 * session's turns, so the cached prefix survives) and routes the volatile blocks
 * into the TURN instead, where they are billed once and then become cached
 * history. With the flag off it falls back to the legacy in-system-prompt
 * assembly. This is the pure, unit-testable core of the cache-stable-prefix
 * feature; the runtime wraps it with the per-session prefix-stability guard.
 */

/** Preamble marking the injected block as system-provided background, not user text. */
export const TURN_CONTEXT_PREAMBLE =
  "Live context for this turn (system-provided background, not the user's words):";

export interface TurnContextInput {
  /** Fully-assembled STABLE system-prompt append (base + job + persona + google + style). */
  stableSystemPromptAppend: string;
  /**
   * Per-turn-volatile blocks in stable order (ToM read, memory digest, elapsed
   * anchor, mood, wiki). Falsy / whitespace-only entries are dropped.
   */
  volatile: Array<string | undefined>;
  /** The user's turn prompt. */
  prompt: string;
  /** When true, volatile context rides in the TURN (cache-stable); else legacy in-append. */
  cacheStablePrefix: boolean;
}

export interface TurnContext {
  /** Final systemPromptAppend passed to runSession (stable when cacheStablePrefix). */
  systemPromptAppend: string;
  /** Final user prompt passed to runSession (carries the volatile context when cacheStablePrefix). */
  effectivePrompt: string;
}

/**
 * Split the stable prefix from the per-turn-volatile context so the cached
 * system block + tools + history survive across a session's turns.
 *
 * INVARIANT (cacheStablePrefix=true): `systemPromptAppend` equals the input's
 * stable append UNCHANGED — regardless of the volatile content — so two turns
 * with identical stable prefixes but different volatile context produce a
 * byte-identical `systemPromptAppend`.
 */
export function buildTurnContext(input: TurnContextInput): TurnContext {
  const parts = input.volatile.filter((s): s is string => Boolean(s && s.trim()));

  if (parts.length === 0) {
    return { systemPromptAppend: input.stableSystemPromptAppend, effectivePrompt: input.prompt };
  }

  if (input.cacheStablePrefix) {
    return {
      // Untouched → byte-identical across a session's turns → the prompt cache survives.
      systemPromptAppend: input.stableSystemPromptAppend,
      effectivePrompt: `${TURN_CONTEXT_PREAMBLE}\n\n${parts.join("\n\n")}\n\n---\n\n${input.prompt}`,
    };
  }

  // Legacy: volatile context back in the system prompt (busts the cache every turn).
  return {
    systemPromptAppend: `${input.stableSystemPromptAppend}\n\n${parts.join("\n\n")}`,
    effectivePrompt: input.prompt,
  };
}
