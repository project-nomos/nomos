import { describe, expect, it } from "vitest";
import { aliasChunkId, normalizeAliases } from "./enrichment.ts";

// normalizeAliases takes an ALREADY-PARSED value (the fork's structured/validated
// output). Fenced/duplicated/malformed JSON extraction is covered by the shared
// coerceStructuredOutput / extractFirstJson tests (reasoning-fork, json-extract).
describe("normalizeAliases", () => {
  it("keeps a clean array of phrases", () => {
    expect(normalizeAliases(["which carrier do I fly", "my airline"])).toEqual([
      "which carrier do I fly",
      "my airline",
    ]);
  });

  it("returns [] for non-arrays (null / object / string / empty)", () => {
    expect(normalizeAliases(null)).toEqual([]);
    expect(normalizeAliases({ not: "an array" })).toEqual([]);
    expect(normalizeAliases("sorry, I cannot help")).toEqual([]);
    expect(normalizeAliases([])).toEqual([]);
  });

  it("drops non-strings, trims, de-dupes case-insensitively, and bounds length", () => {
    expect(
      normalizeAliases([
        "  spaced  ",
        "Spaced",
        42,
        null,
        "okay",
        "x", // too short (<3)
        "a".repeat(300), // too long (>200)
      ]),
    ).toEqual(["spaced", "okay"]);
  });

  it("caps at the max alias count", () => {
    expect(
      normalizeAliases(["alias1", "alias2", "alias3", "alias4", "alias5", "alias6", "alias7"]),
    ).toHaveLength(5);
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
