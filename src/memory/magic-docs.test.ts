import { describe, it, expect } from "vitest";
import { detectMagicDoc } from "./magic-docs.ts";

describe("detectMagicDoc", () => {
  it("detects a real standalone marker line (with a title)", () => {
    expect(detectMagicDoc("<!-- MAGIC DOC: API Reference -->\n\n# API\n...")).toBe("API Reference");
  });

  it("tolerates leading/trailing whitespace around a standalone marker", () => {
    expect(detectMagicDoc("   <!--  MAGIC DOC:  Notes  -->  \nbody")).toBe("Notes");
  });

  it("returns null when there is no marker", () => {
    expect(detectMagicDoc("# Just a normal doc\nno marker here")).toBeNull();
  });

  // The regression this guards: docs that DOCUMENT the marker syntax (README.md,
  // CLAUDE.md) must NOT be detected as magic docs, or the background refresher
  // rewrites the project's canonical files in place.
  it("ignores an inline mention inside a sentence (the README/CLAUDE.md case)", () => {
    const claudeLine =
      "- **Magic Docs** -- markdown files with `<!-- MAGIC DOC: title -->` marker are auto-updated when stale.";
    expect(detectMagicDoc(claudeLine)).toBeNull();
  });

  it("ignores a mention inside a code span mid-paragraph", () => {
    const readmeLine =
      "Markdown files with a `<!-- MAGIC DOC: title -->` marker are automatically kept up-to-date.";
    expect(detectMagicDoc(readmeLine)).toBeNull();
  });

  it("still finds a standalone marker even when the file also mentions the syntax inline", () => {
    const doc = [
      "<!-- MAGIC DOC: Architecture -->",
      "",
      "This doc explains the `<!-- MAGIC DOC: title -->` convention.",
    ].join("\n");
    expect(detectMagicDoc(doc)).toBe("Architecture");
  });
});
