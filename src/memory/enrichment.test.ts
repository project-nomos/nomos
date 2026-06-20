import { describe, expect, it } from "vitest";
import { aliasChunkId, parseAliases } from "./enrichment.ts";

describe("parseAliases", () => {
  it("parses a JSON array of phrases", () => {
    expect(parseAliases('["which carrier do I fly", "my airline"]')).toEqual([
      "which carrier do I fly",
      "my airline",
    ]);
  });

  it("extracts the array from surrounding prose / code fences", () => {
    const raw = 'Here you go:\n```json\n["how I take my coffee", "cafe order"]\n```';
    expect(parseAliases(raw)).toEqual(["how I take my coffee", "cafe order"]);
  });

  it("handles a fenced array repeated twice (takes the first, not the greedy span)", () => {
    const dup = '["which airline do I prefer", "aisle seat"]';
    const raw = "```json\n" + dup + "\n``````json\n" + dup + "\n```";
    expect(parseAliases(raw)).toEqual(["which airline do I prefer", "aisle seat"]);
  });

  it("returns [] on non-JSON, non-array, or empty", () => {
    expect(parseAliases("sorry, I cannot help")).toEqual([]);
    expect(parseAliases('{"not":"an array"}')).toEqual([]);
    expect(parseAliases("[]")).toEqual([]);
    expect(parseAliases('["valid but unterminated')).toEqual([]);
  });

  it("drops non-strings, trims, de-dupes case-insensitively, and bounds length", () => {
    const raw = JSON.stringify([
      "  spaced  ",
      "Spaced",
      42,
      null,
      "okay",
      "x", // too short (<3)
      "a".repeat(300), // too long (>200)
    ]);
    expect(parseAliases(raw)).toEqual(["spaced", "okay"]);
  });

  it("caps at the max alias count", () => {
    const raw = JSON.stringify([
      "alias1",
      "alias2",
      "alias3",
      "alias4",
      "alias5",
      "alias6",
      "alias7",
    ]);
    expect(parseAliases(raw)).toHaveLength(5);
  });
});

describe("aliasChunkId", () => {
  it("is deterministic and shares the note's vault chunk prefix (so forget cleans it up)", () => {
    const a = aliasChunkId("u1", "notes/coffee.md", 0);
    const b = aliasChunkId("u1", "notes/coffee.md", 0);
    expect(a).toBe(b);
    expect(a).toMatch(/^vault:[0-9a-f]{16}:alias:0$/);
  });

  it("is per-user and per-note namespaced", () => {
    expect(aliasChunkId("u1", "n.md", 0)).not.toBe(aliasChunkId("u2", "n.md", 0));
    expect(aliasChunkId("u1", "a.md", 0)).not.toBe(aliasChunkId("u1", "b.md", 0));
    expect(aliasChunkId("u1", "n.md", 0)).not.toBe(aliasChunkId("u1", "n.md", 1));
  });
});
