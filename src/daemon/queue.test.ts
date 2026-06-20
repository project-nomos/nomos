import { describe, expect, it } from "vitest";
import { MessageDedupe } from "./queue.ts";

describe("MessageDedupe (at-least-once idempotency guard)", () => {
  it("claims an id exactly once; redelivery of the same id is skipped", () => {
    const d = new MessageDedupe();
    expect(d.claim("m1")).toBe(true); // first delivery -> process
    expect(d.claim("m1")).toBe(false); // XAUTOCLAIM redelivery -> skip
    expect(d.claim("m1")).toBe(false);
    expect(d.claim("m2")).toBe(true); // a different message still processes
  });

  it("reports membership and size", () => {
    const d = new MessageDedupe();
    expect(d.has("x")).toBe(false);
    d.claim("x");
    expect(d.has("x")).toBe(true);
    expect(d.size).toBe(1);
  });

  it("is bounded: evicts oldest ids past the cap (memory can't grow unbounded)", () => {
    const d = new MessageDedupe(3);
    d.claim("a");
    d.claim("b");
    d.claim("c");
    expect(d.size).toBe(3);
    d.claim("d"); // evicts "a"
    expect(d.size).toBe(3);
    expect(d.has("a")).toBe(false);
    expect(d.has("d")).toBe(true);
    // "a" evicted, so it would be processed again if redelivered after the window —
    // acceptable: the cap bounds the dedupe horizon, far larger than reclaim latency.
    expect(d.claim("a")).toBe(true);
  });
});
