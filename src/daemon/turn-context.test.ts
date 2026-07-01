import { describe, it, expect } from "vitest";
import { buildTurnContext, TURN_CONTEXT_PREAMBLE } from "./turn-context.ts";

const STABLE = "## Identity\nYou are the agent.\n## Skills\n- a\n- b";

describe("buildTurnContext (cache-stable prefix, #0)", () => {
  it("keeps systemPromptAppend UNCHANGED and moves volatile context into the turn (cache-stable)", () => {
    const out = buildTurnContext({
      stableSystemPromptAppend: STABLE,
      volatile: ["## User State\nfocused", "## Digest\nknows X"],
      prompt: "what's next?",
      cacheStablePrefix: true,
    });

    // The cached prefix is untouched — the whole point of #0.
    expect(out.systemPromptAppend).toBe(STABLE);
    // Volatile context + the original prompt ride in the turn, preamble first.
    expect(out.effectivePrompt).toBe(
      `${TURN_CONTEXT_PREAMBLE}\n\n## User State\nfocused\n\n## Digest\nknows X\n\n---\n\nwhat's next?`,
    );
    expect(out.effectivePrompt).toContain("what's next?");
  });

  it("INVARIANT: two turns with different volatile context yield a byte-identical systemPromptAppend", () => {
    const turn1 = buildTurnContext({
      stableSystemPromptAppend: STABLE,
      volatile: ["## User State\nfocused", "## Digest\nknows X"],
      prompt: "turn one",
      cacheStablePrefix: true,
    });
    const turn2 = buildTurnContext({
      stableSystemPromptAppend: STABLE,
      volatile: ["## User State\nstressed", "## Digest\nknows Y", "## Mood\ntired"],
      prompt: "turn two",
      cacheStablePrefix: true,
    });

    // Same stable prefix across turns → the SDK prompt cache survives.
    expect(turn1.systemPromptAppend).toBe(turn2.systemPromptAppend);
    // But the turn content differs (the volatile context lives here, uncached-once).
    expect(turn1.effectivePrompt).not.toBe(turn2.effectivePrompt);
  });

  it("preserves volatile order and drops falsy/whitespace entries", () => {
    const out = buildTurnContext({
      stableSystemPromptAppend: STABLE,
      volatile: ["tom", undefined, "digest", "", "   ", "wiki"],
      prompt: "p",
      cacheStablePrefix: true,
    });
    const body = out.effectivePrompt.slice(
      TURN_CONTEXT_PREAMBLE.length + 2,
      out.effectivePrompt.indexOf("\n\n---\n\n"),
    );
    expect(body).toBe("tom\n\ndigest\n\nwiki");
  });

  it("legacy mode (flag off) appends volatile context back into systemPromptAppend, leaves prompt bare", () => {
    const out = buildTurnContext({
      stableSystemPromptAppend: STABLE,
      volatile: ["## User State\nfocused"],
      prompt: "hello",
      cacheStablePrefix: false,
    });
    expect(out.systemPromptAppend).toBe(`${STABLE}\n\n## User State\nfocused`);
    expect(out.effectivePrompt).toBe("hello");
  });

  it("no volatile context → both stable append and prompt pass through untouched (either mode)", () => {
    for (const cacheStablePrefix of [true, false]) {
      const out = buildTurnContext({
        stableSystemPromptAppend: STABLE,
        volatile: [undefined, "", "  "],
        prompt: "hi",
        cacheStablePrefix,
      });
      expect(out.systemPromptAppend).toBe(STABLE);
      expect(out.effectivePrompt).toBe("hi");
    }
  });
});
