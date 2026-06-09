import { describe, it, expect } from "vitest";
import { ToolResultStore } from "./tool-result-storage.ts";

const big = (seed: string) => seed + "x".repeat(2500);

describe("ToolResultStore", () => {
  it("passes small results through untouched", () => {
    const s = new ToolResultStore();
    const out = s.processResult("Read", "short");
    expect(out.deduplicated).toBe(false);
    expect(out.content).toBe("short");
  });

  it("stores a first large result unchanged, then dedups an identical repeat", () => {
    const s = new ToolResultStore();
    const content = big("A");
    const first = s.processResult("Read", content);
    expect(first.deduplicated).toBe(false);
    expect(first.content).toBe(content);

    const second = s.processResult("Read", content);
    expect(second.deduplicated).toBe(true);
    expect(second.content).toMatch(/^\[Cached result from Read/);
    expect(second.tokensSaved).toBeGreaterThan(0);
  });

  it("resolveReference round-trips the dedup reference back to the original bytes", () => {
    const s = new ToolResultStore();
    const content = big("B");
    s.processResult("Grep", content);
    const ref = s.processResult("Grep", content).content;
    const hash = ref.match(/ref:([0-9a-f]+)/)?.[1];
    expect(hash).toBeTruthy();
    expect(s.resolveReference(hash!)).toBe(content);
  });

  it("evicts down to the cap when more than 500 distinct large results are stored", () => {
    const s = new ToolResultStore();
    for (let i = 0; i < 520; i++) s.processResult("Read", big(`seed-${i}-`));
    expect(s.getStats().storedCount).toBeLessThanOrEqual(500);
  });

  it("getStats reflects dedup totals", () => {
    const s = new ToolResultStore();
    const content = big("C");
    s.processResult("Read", content);
    s.processResult("Read", content);
    const stats = s.getStats();
    expect(stats.totalDeduplications).toBe(1);
    expect(stats.totalTokensSaved).toBeGreaterThan(0);
  });
});
