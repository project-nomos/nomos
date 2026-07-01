import { describe, it, expect } from "vitest";
import {
  resolveWikiLint,
  findOrphans,
  findDanglingLinks,
  renderLintReport,
  type LintArticle,
} from "./wiki-lint.ts";

const HOUR_MS = 60 * 60 * 1000;

describe("resolveWikiLint", () => {
  it("falls back to the 24h default when nothing is configured", () => {
    expect(resolveWikiLint({})).toEqual({ enabled: true, intervalMs: 24 * HOUR_MS });
  });

  it("reads enabled + interval from config", () => {
    expect(resolveWikiLint({ wikiLintEnabled: true, wikiLintInterval: "6h" })).toEqual({
      enabled: true,
      intervalMs: 6 * HOUR_MS,
    });
  });

  it("keeps the default cadence when the interval string is invalid", () => {
    expect(resolveWikiLint({ wikiLintInterval: "not-a-duration" }).intervalMs).toBe(24 * HOUR_MS);
  });

  it("treats boolean false and the legacy string 'false' seed as disabled", () => {
    expect(resolveWikiLint({ wikiLintEnabled: false }).enabled).toBe(false);
    expect(resolveWikiLint({ wikiLintEnabled: "false" as unknown as boolean }).enabled).toBe(false);
  });

  it("treats the string 'true' seed and undefined as enabled", () => {
    expect(resolveWikiLint({ wikiLintEnabled: "true" as unknown as boolean }).enabled).toBe(true);
    expect(resolveWikiLint({}).enabled).toBe(true);
  });
});

const A = (over: Partial<LintArticle>): LintArticle => ({
  path: "topics/x.md",
  title: "X",
  category: "topics",
  backlinks: [],
  ...over,
});

describe("findOrphans", () => {
  it("flags an article that nothing links to", () => {
    const articles = [
      A({ path: "people/dana.md", title: "Dana", backlinks: ["Atlas"] }),
      A({ path: "projects/atlas.md", title: "Atlas", backlinks: [] }), // linked by Dana -> not orphan
      A({ path: "people/maya.md", title: "Maya", backlinks: [] }), // nobody links -> orphan
    ];
    const orphans = findOrphans(articles);
    expect(orphans.map((a) => a.title)).toEqual(["Dana", "Maya"]);
    // Atlas is referenced by Dana's [[Atlas]] so it is NOT orphaned.
    expect(orphans.some((a) => a.title === "Atlas")).toBe(false);
  });

  it("resolves inbound links by title, path, or path-without-.md", () => {
    const articles = [
      A({ path: "a.md", title: "A", backlinks: ["projects/atlas.md"] }),
      A({ path: "projects/atlas.md", title: "Atlas", backlinks: [] }),
    ];
    expect(findOrphans(articles).some((a) => a.title === "Atlas")).toBe(false);
  });

  it("never reports meta articles (index/lint) as orphans", () => {
    const articles = [
      A({ path: "_index.md", title: "Index", category: "index" }),
      A({ path: "_lint.md", title: "Lint", category: "lint" }),
    ];
    expect(findOrphans(articles)).toHaveLength(0);
  });
});

describe("findDanglingLinks", () => {
  it("flags a [[Target]] that resolves to no article", () => {
    const articles = [
      A({ path: "people/raj.md", title: "Raj", backlinks: ["Project Atlas", "Dana"] }),
      A({ path: "people/dana.md", title: "Dana", backlinks: [] }),
    ];
    const dangling = findDanglingLinks(articles);
    expect(dangling).toEqual([{ target: "Project Atlas", from: "people/raj.md" }]);
  });

  it("dedupes (target, from) pairs", () => {
    const articles = [A({ path: "a.md", title: "A", backlinks: ["Ghost", "Ghost"] })];
    expect(findDanglingLinks(articles)).toHaveLength(1);
  });
});

describe("renderLintReport", () => {
  it("renders each section with counts and the suggested follow-ups", () => {
    const body = renderLintReport({
      articleCount: 3,
      orphans: [A({ path: "people/maya.md", title: "Maya" })],
      dangling: [{ target: "Project Atlas", from: "people/raj.md" }],
      superseded: [{ fact: "works at OldCo", invalidAt: new Date("2026-01-02T00:00:00Z") }],
    });
    expect(body).toContain("# Wiki Lint Report");
    expect(body).toContain("Orphan articles — no inbound links (1)");
    expect(body).toContain("[Maya](people/maya.md)");
    expect(body).toContain("Missing pages — mentioned but no article (1)");
    expect(body).toContain("[[Project Atlas]]");
    expect(body).toContain("works at OldCo");
    expect(body).toContain("2026-01-02");
    expect(body).toContain("Suggested follow-ups");
  });

  it("reports clean sections when there is nothing to flag", () => {
    const body = renderLintReport({ articleCount: 2, orphans: [], dangling: [], superseded: [] });
    expect(body).toContain("Every article is linked from somewhere");
    expect(body).toContain("Every [[link]] resolves to an article");
    expect(body).not.toContain("Suggested follow-ups");
  });
});
