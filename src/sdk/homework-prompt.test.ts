import { describe, expect, it } from "vitest";
import { buildHomeworkPrompt } from "./homework-prompt.ts";

describe("buildHomeworkPrompt", () => {
  it("instructs draft-then-confirm and never auto-submit", () => {
    const p = buildHomeworkPrompt("");
    expect(p.toLowerCase()).toContain("not turned in");
    expect(p).toMatch(/only after i confirm/i);
    expect(p).toMatch(/without my explicit approval/i);
  });

  it("appends extra instruction when present", () => {
    expect(buildHomeworkPrompt("only math")).toContain("Additional instruction: only math");
  });

  it("is tool-agnostic (no MCP tool names — power-user uses the gws CLI)", () => {
    expect(buildHomeworkPrompt("")).not.toContain("classroom_draft_submission");
  });
});
