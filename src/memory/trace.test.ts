import { describe, it, expect } from "vitest";
import { traceMemory, getMemoryStats } from "./trace.ts";

describe("memory trace", () => {
  it("tracks recall hit rate and write count", () => {
    const before = getMemoryStats();
    traceMemory({ op: "recall_search", userId: "u", query: "x", resultCount: 3 }); // hit
    traceMemory({ op: "recall_vault", userId: "u", query: "y", resultCount: 0 }); // miss
    traceMemory({ op: "write_vault", userId: "u", ref: "a.md", writeCount: 1 });
    traceMemory({ op: "write_chunk", userId: "u", ref: "s", writeCount: 2 });
    traceMemory({ op: "forget", userId: "u", ref: "a.md" }); // neither recall nor write

    const after = getMemoryStats();
    expect(after.recalls - before.recalls).toBe(2);
    expect(after.recallHits - before.recallHits).toBe(1);
    expect(after.writes - before.writes).toBe(2);
    expect(after.recallHitRate).toBeGreaterThan(0);
    expect(after.recallHitRate).toBeLessThanOrEqual(1);
  });

  it("never throws on a malformed event", () => {
    expect(() =>
      traceMemory({ op: "recall_search", userId: "u" } as Parameters<typeof traceMemory>[0]),
    ).not.toThrow();
  });
});
