import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db/style-profiles.ts", () => ({ getStyleProfile: vi.fn() }));

import { getStyleProfile } from "../db/style-profiles.ts";
import { buildStyleGuidance } from "./style-prompt.ts";

const get = getStyleProfile as unknown as ReturnType<typeof vi.fn>;

const profile = {
  formality: 1,
  avgLength: 8,
  emojiUsage: "none",
  punctuation: "minimal",
  greetingStyle: "hey",
  signoffStyle: "none",
  vocabulary: ["lgtm", "ship it"],
  tone: "direct",
  casing: "lowercase",
  responseSpeed: "brief",
};

describe("buildStyleGuidance", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns '' when the owner has no global profile", async () => {
    get.mockResolvedValue(null);
    expect(await buildStyleGuidance("local")).toBe("");
    expect(get).toHaveBeenCalledWith("local", "global");
  });

  it("turns a profile into natural-language style directives", async () => {
    get.mockImplementation(async (_userId: string, scope: string) =>
      scope === "global" ? { profile } : null,
    );
    const out = await buildStyleGuidance("local");
    expect(out).toContain("## Communication Style");
    expect(out).toContain("very casually");
    expect(out).toContain("lowercase");
    expect(out).toContain("Do not use emojis");
    expect(out).toContain('Greet with: "hey"');
    expect(out).toContain("lgtm");
  });

  it("is owner-scoped: reads the global profile for the passed user", async () => {
    get.mockResolvedValue({ profile });
    await buildStyleGuidance("user-42");
    expect(get).toHaveBeenCalledWith("user-42", "global");
  });
});
