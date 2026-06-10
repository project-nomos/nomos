import { describe, it, expect } from "vitest";
import { resolveWiki } from "./knowledge-compiler.ts";

const HOUR_MS = 60 * 60 * 1000;

describe("resolveWiki", () => {
  it("falls back to the constant defaults when nothing is configured", () => {
    expect(resolveWiki({})).toEqual({
      enabled: true,
      intervalMs: HOUR_MS,
      model: "claude-sonnet-4-6",
      maxArticles: 20,
    });
  });

  it("reads interval, model, and maxArticles from config", () => {
    expect(
      resolveWiki({
        wikiEnabled: true,
        wikiCompileInterval: "30m",
        wikiCompileModel: "claude-opus-4-8",
        wikiMaxArticlesPerRun: 5,
      }),
    ).toEqual({
      enabled: true,
      intervalMs: 30 * 60 * 1000,
      model: "claude-opus-4-8",
      maxArticles: 5,
    });
  });

  it("parses duration units (2h -> ms)", () => {
    expect(resolveWiki({ wikiCompileInterval: "2h" }).intervalMs).toBe(2 * HOUR_MS);
  });

  it("keeps the default cadence when the interval string is invalid", () => {
    expect(resolveWiki({ wikiCompileInterval: "not-a-duration" }).intervalMs).toBe(HOUR_MS);
  });

  it("ignores non-positive / non-numeric maxArticles", () => {
    expect(resolveWiki({ wikiMaxArticlesPerRun: 0 }).maxArticles).toBe(20);
    expect(resolveWiki({ wikiMaxArticlesPerRun: -3 }).maxArticles).toBe(20);
    expect(resolveWiki({ wikiMaxArticlesPerRun: NaN }).maxArticles).toBe(20);
  });

  it("floors a fractional maxArticles", () => {
    expect(resolveWiki({ wikiMaxArticlesPerRun: 7.9 }).maxArticles).toBe(7);
  });

  it("treats boolean false as disabled", () => {
    expect(resolveWiki({ wikiEnabled: false }).enabled).toBe(false);
  });

  it("treats the legacy string 'false' seed as disabled (defensive coercion)", () => {
    // The config store seeds booleans as JSON strings, so wikiEnabled can arrive
    // as the string "false" at runtime. It must still disable the compiler.
    expect(resolveWiki({ wikiEnabled: "false" as unknown as boolean }).enabled).toBe(false);
  });

  it("treats the string 'true' seed and undefined as enabled", () => {
    expect(resolveWiki({ wikiEnabled: "true" as unknown as boolean }).enabled).toBe(true);
    expect(resolveWiki({}).enabled).toBe(true);
  });
});
