import { describe, it, expect } from "vitest";
import { AssistantText } from "./assistant-text.ts";

describe("AssistantText", () => {
  it("reproduces the prior raw-concat output when nothing is evicted", () => {
    const a = new AssistantText();
    a.add("m1", "Hello");
    a.add("m1", "world"); // second block of the same message
    a.add("m2", "again");
    // Matches the old `if (out && !out.endsWith("\\n")) out += "\\n"; out += block`
    expect(a.toString()).toBe("Hello\nworld\nagain");
  });

  it("preserves an existing trailing newline without doubling it", () => {
    const a = new AssistantText();
    a.add("m1", "line\n");
    a.add("m2", "next");
    expect(a.toString()).toBe("line\nnext");
  });

  it("evicts a refused partial via supersedes (evict-on-arrival)", () => {
    const a = new AssistantText();
    a.add("refused", "I cannot help with that"); // primary model's refused partial
    a.evict(["refused"]); // replacement assistant message carried supersedes:["refused"]
    a.add("fallback", "Here is the answer");
    expect(a.toString()).toBe("Here is the answer");
  });

  it("evicts via the end-of-turn retracted_message_uuids backstop", () => {
    const a = new AssistantText();
    a.add("p1", "partial one");
    a.add("p2", "partial two");
    a.add("real", "real answer");
    a.evict(["p1", "p2"]); // model_refusal_fallback notice
    expect(a.toString()).toBe("real answer");
  });

  it("eviction is idempotent and ignores unknown uuids", () => {
    const a = new AssistantText();
    a.add("m1", "keep");
    a.evict(["nope"]);
    a.evict(undefined);
    a.evict([]);
    expect(a.toString()).toBe("keep");
    expect(a.isEmpty).toBe(false);
  });

  it("setResult replaces everything (compaction fallback path)", () => {
    const a = new AssistantText();
    a.add("m1", "streamed");
    a.setResult("final");
    expect(a.toString()).toBe("final");
    const empty = new AssistantText();
    expect(empty.isEmpty).toBe(true);
    empty.setResult("x");
    expect(empty.isEmpty).toBe(false);
  });

  it("skips empty text blocks", () => {
    const a = new AssistantText();
    a.add("m1", "");
    expect(a.isEmpty).toBe(true);
    a.add("m1", "real");
    expect(a.toString()).toBe("real");
  });
});
