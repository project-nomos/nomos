import { beforeEach, describe, expect, it, vi } from "vitest";

const vaultRead = vi.fn();
const getUserModel = vi.fn();
vi.mock("./vault.ts", () => ({ vaultRead: (...a: unknown[]) => vaultRead(...a) }));
vi.mock("../db/user-model.ts", () => ({ getUserModel: (...a: unknown[]) => getUserModel(...a) }));

const { buildMemoryDigest } = await import("./digest.ts");

beforeEach(() => {
  vaultRead.mockReset().mockResolvedValue(null);
  getUserModel.mockReset().mockResolvedValue([]);
});

describe("buildMemoryDigest", () => {
  it("returns '' when there is no profile and no model", async () => {
    expect(await buildMemoryDigest("u1")).toBe("");
  });

  it("includes the profile note and high-confidence model entries grouped by category", async () => {
    vaultRead.mockResolvedValue({ content: "Meidad, founder of Nomos." });
    getUserModel.mockResolvedValue([
      { category: "preference", key: "coffee", value: "black", confidence: 0.9 },
      { category: "fact", key: "city", value: "SF", confidence: 0.8 },
      { category: "noise", key: "x", value: "y", confidence: 0.1 }, // below threshold
    ]);
    const d = await buildMemoryDigest("u1");
    expect(d).toContain("What you know about this user");
    expect(d).toContain("Meidad, founder of Nomos.");
    expect(d).toContain("### preference");
    expect(d).toContain("coffee: black");
    expect(d).toContain("### fact");
    expect(d).not.toContain("x: y"); // filtered out by confidence threshold
  });

  it("survives a failing user_model and still injects the profile", async () => {
    vaultRead.mockResolvedValue({ content: "Just the profile." });
    getUserModel.mockRejectedValue(new Error("db down"));
    const d = await buildMemoryDigest("u1");
    expect(d).toContain("Just the profile.");
  });
});
