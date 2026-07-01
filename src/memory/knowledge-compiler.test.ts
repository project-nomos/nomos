import { describe, it, expect } from "vitest";
import { resolveWiki, buildArticlePrompt, type ArticleSources } from "./knowledge-compiler.ts";

const HOUR_MS = 60 * 60 * 1000;

const emptySources = (over: Partial<ArticleSources> = {}): ArticleSources => ({
  facts: [],
  conversations: [],
  contact: undefined,
  existingContent: null,
  vaultNotes: [],
  superseded: [],
  schemaDoc: null,
  ...over,
});

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

describe("buildArticlePrompt", () => {
  const plan = { path: "people/raj.md", title: "Raj Patel", category: "contacts" };

  it("feeds the vault notes into the body as the SOURCE OF TRUTH (#1)", () => {
    const prompt = buildArticlePrompt(
      plan,
      emptySources({
        vaultNotes: [
          {
            path: "people/raj.md",
            title: "Raj Patel",
            content: "Raj is vegetarian, allergic to peanuts.",
          },
        ],
      }),
    );
    expect(prompt).toContain("SOURCE OF TRUTH");
    expect(prompt).toContain("allergic to peanuts");
  });

  it("says so when there are no authored notes on the topic", () => {
    const prompt = buildArticlePrompt(plan, emptySources());
    expect(prompt).toContain("No authored notes on this topic");
  });

  it("threads superseded facts + instructs the model to state the change (#3)", () => {
    const prompt = buildArticlePrompt(
      plan,
      emptySources({
        superseded: [{ fact: "Raj works at OldCo", invalidAt: new Date("2026-02-03T00:00:00Z") }],
      }),
    );
    expect(prompt).toContain("SUPERSEDED / OUTDATED");
    expect(prompt).toContain("Raj works at OldCo");
    expect(prompt).toContain("2026-02-03");
    expect(prompt).toContain("state the change explicitly");
  });

  it("injects the WIKI.md schema conventions when present (#4)", () => {
    const prompt = buildArticlePrompt(
      plan,
      emptySources({ schemaDoc: "# Wiki conventions\n- Group by category as category/title.md" }),
    );
    expect(prompt).toContain("WIKI CONVENTIONS");
    expect(prompt).toContain("Group by category");
  });

  it("omits the schema + superseded sections when they are absent", () => {
    const prompt = buildArticlePrompt(plan, emptySources());
    expect(prompt).not.toContain("WIKI CONVENTIONS");
    expect(prompt).not.toContain("SUPERSEDED / OUTDATED");
    // still always asks for the article + wikilinks
    expect(prompt).toContain("wrap that name in double brackets like [[Name]]");
  });
});
