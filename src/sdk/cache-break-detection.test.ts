import { describe, it, expect } from "vitest";
import { PromptCacheTracker } from "./cache-break-detection.ts";

const base = { systemPrompt: "you are nomos", toolSchemas: "a,b", model: "opus", betas: ["x"] };

describe("PromptCacheTracker", () => {
  it("the first check is never a break", () => {
    const t = new PromptCacheTracker();
    expect(t.check(base).broken).toBe(false);
  });

  it("identical components in a row do not break the cache", () => {
    const t = new PromptCacheTracker();
    t.check(base);
    expect(t.check({ ...base }).broken).toBe(false);
  });

  it("a changed system prompt is a break and is reported", () => {
    const t = new PromptCacheTracker();
    t.check(base);
    const r = t.check({ ...base, systemPrompt: "different" });
    expect(r.broken).toBe(true);
    expect(r.changes).toContain("systemPrompt");
  });

  it("a model change names the transition", () => {
    const t = new PromptCacheTracker();
    t.check(base);
    const r = t.check({ ...base, model: "sonnet" });
    expect(r.broken).toBe(true);
    expect(r.changes.some((c) => c.includes("opus") && c.includes("sonnet"))).toBe(true);
  });

  it("getBreakCount increments only on real breaks; reset clears state", () => {
    const t = new PromptCacheTracker();
    t.check(base);
    t.check(base); // no break
    expect(t.getBreakCount()).toBe(0);
    t.check({ ...base, model: "haiku" }); // break #1
    expect(t.getBreakCount()).toBe(1);
    t.reset();
    expect(t.check(base).broken).toBe(false); // treated as first again
  });
});
