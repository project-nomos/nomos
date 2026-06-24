import { describe, it, expect } from "vitest";
import { extractFirstJson, coerceJson } from "./json-extract.ts";

describe("extractFirstJson", () => {
  it("parses a plain object", () => {
    expect(extractFirstJson('{"a":1,"b":"x"}')).toEqual({ a: 1, b: "x" });
  });

  it("strips ```json fences", () => {
    expect(extractFirstJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  // The actual prod bug: forked-agent returns the answer DUPLICATED + fenced, so a
  // greedy first-{…}-to-last-} match splices both copies (+ fence junk) into invalid
  // JSON and JSON.parse throws -> extraction silently returned nothing.
  it("takes the FIRST balanced object when the answer is duplicated + fenced", () => {
    const duplicated =
      '```json\n{"facts":[{"text":"hi"}]}\n``````json\n{"facts":[{"text":"hi"}]}\n```';
    expect(extractFirstJson(duplicated)).toEqual({ facts: [{ text: "hi" }] });
    // sanity: the old greedy approach would have produced invalid JSON
    const greedy = duplicated.match(/\{[\s\S]*\}/)![0];
    expect(() => JSON.parse(greedy)).toThrow();
  });

  it("ignores surrounding prose", () => {
    expect(extractFirstJson('Here is the result: {"a":1} — done.')).toEqual({ a: 1 });
  });

  it("handles arrays (and duplication)", () => {
    expect(extractFirstJson("```json\n[1,2,3]\n```")).toEqual([1, 2, 3]);
    expect(extractFirstJson("[1,2][1,2]")).toEqual([1, 2]);
  });

  it("respects braces inside strings", () => {
    expect(extractFirstJson('{"a":"}{ not a brace","b":2}')).toEqual({ a: "}{ not a brace", b: 2 });
  });

  it("returns null when there is no JSON", () => {
    expect(extractFirstJson("no json here")).toBeNull();
    expect(extractFirstJson("")).toBeNull();
  });

  it("skips an invalid leading bracket and finds the next valid value", () => {
    // first `{` opens a non-JSON snippet; the real object follows
    expect(extractFirstJson('prefix {not json} then {"a":1}')).toEqual({ a: 1 });
  });
});

describe("coerceJson", () => {
  it("parses a JSON string", () => {
    expect(coerceJson('{"a":1}')).toEqual({ a: 1 });
  });
  it("passes through an object unchanged", () => {
    const o = { a: 1 };
    expect(coerceJson(o)).toBe(o);
  });
  it("passes through a non-JSON string unchanged", () => {
    expect(coerceJson("hello")).toBe("hello");
  });
  it("passes through undefined", () => {
    expect(coerceJson(undefined)).toBeUndefined();
  });
});
