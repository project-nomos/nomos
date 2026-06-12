import { describe, expect, it } from "vitest";
import { markdownToSlackMrkdwn } from "./slack-mrkdwn.ts";

const md = markdownToSlackMrkdwn;

describe("markdownToSlackMrkdwn", () => {
  describe("emphasis", () => {
    it("converts **bold** to *bold* (not italic — the regression)", () => {
      expect(md("**bold**")).toBe("*bold*");
    });

    it("converts __bold__ to *bold*", () => {
      expect(md("__bold__")).toBe("*bold*");
    });

    it("converts *italic* to _italic_", () => {
      expect(md("*italic*")).toBe("_italic_");
    });

    it("keeps bold and italic distinct in one line", () => {
      expect(md("**b** and *i*")).toBe("*b* and _i_");
    });

    it("leaves underscore italic as-is", () => {
      expect(md("_italic_")).toBe("_italic_");
    });

    it("converts ~~strike~~ to ~strike~", () => {
      expect(md("~~gone~~")).toBe("~gone~");
    });
  });

  describe("headings", () => {
    it("converts # / ###### headings to bold", () => {
      expect(md("# Title")).toBe("*Title*");
      expect(md("### Sub")).toBe("*Sub*");
    });

    it("strips trailing closing hashes", () => {
      expect(md("## Title ##")).toBe("*Title*");
    });
  });

  describe("bullets", () => {
    it("converts -, *, + markers to a bullet char", () => {
      expect(md("- a\n* b\n+ c")).toBe("• a\n• b\n• c");
    });

    it("uses a hollow bullet for nested items and keeps indentation", () => {
      expect(md("- top\n  - nested")).toBe("• top\n  ◦ nested");
    });

    it("converts bold inside a bullet", () => {
      expect(md("- **done**")).toBe("• *done*");
    });

    it("does not treat *emphasis* at start of inline text as a bullet", () => {
      expect(md("an *italic* word")).toBe("an _italic_ word");
    });
  });

  describe("links and images", () => {
    it("converts [text](url) to <url|text>", () => {
      expect(md("see [docs](https://x.dev/a)")).toBe("see <https://x.dev/a|docs>");
    });

    it("renders images as their alt text", () => {
      expect(md("![a diagram](https://x.dev/i.png)")).toBe("a diagram");
    });
  });

  describe("code", () => {
    it("strips the language identifier from a fenced block", () => {
      expect(md("```go\nx := 1\n```")).toBe("```\nx := 1\n```");
    });

    it("keeps a fenced block with no language untouched", () => {
      expect(md("```\nplain\n```")).toBe("```\nplain\n```");
    });

    it("does not convert markdown inside a code block", () => {
      const input = "```\n# not a heading\n**not bold**\n- not a bullet\n```";
      expect(md(input)).toBe(input);
    });

    it("does not convert markdown inside inline code", () => {
      expect(md("call `**foo**` now")).toBe("call `**foo**` now");
    });
  });

  describe("misc", () => {
    it("turns a horizontal rule into a divider", () => {
      expect(md("---")).toBe("─".repeat(10));
    });

    it("leaves Slack emoji shortcodes alone", () => {
      expect(md("done :white_check_mark:")).toBe("done :white_check_mark:");
    });
  });

  it("renders a realistic agent message correctly", () => {
    const input = [
      "## Status",
      "",
      "1. Factor duplication :white_check_mark: done",
      "- **Nil logger** panic is a [blocker](https://x.dev/pr/1)",
      "",
      "```go",
      'config.Logger.Warn(ctx, "defaulting")',
      "```",
    ].join("\n");

    const out = md(input);

    expect(out).toContain("*Status*"); // heading -> bold
    expect(out).toContain("• *Nil logger* panic"); // bullet + bold
    expect(out).toContain("<https://x.dev/pr/1|blocker>"); // link
    expect(out).toContain("```\nconfig.Logger.Warn"); // code fence, lang stripped
    expect(out).toContain(":white_check_mark:"); // emoji preserved
    expect(out).not.toContain("```go"); // language tag gone
    expect(out).not.toContain("**"); // no leftover double-asterisks
  });
});
