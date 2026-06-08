import { describe, it, expect } from "vitest";
import { extractJson } from "./judge.ts";

describe("extractJson", () => {
  it("extracts a bare JSON object", () => {
    expect(extractJson('{"pass": true, "score": 1}')).toBe('{"pass": true, "score": 1}');
  });

  it("ignores trailing prose after the object (the regression that bit us)", () => {
    const text = '{"pass": true, "score": 1, "reasoning": "ok"}\n\nHope that helps!';
    expect(JSON.parse(extractJson(text)!)).toMatchObject({ pass: true });
  });

  it("survives markdown code fences", () => {
    const text = '```json\n{"pass": false, "score": 0}\n```';
    expect(JSON.parse(extractJson(text)!)).toMatchObject({ pass: false });
  });

  it("does not stop at a brace inside a string value", () => {
    const text = '{"reasoning": "the note says {oat milk}", "pass": true}';
    expect(JSON.parse(extractJson(text)!)).toMatchObject({ pass: true });
  });

  it("returns null when there is no object", () => {
    expect(extractJson("no json here")).toBeNull();
  });
});
