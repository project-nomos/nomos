import { beforeEach, describe, expect, it, vi } from "vitest";

const { getUserModel } = vi.hoisted(() => ({ getUserModel: vi.fn() }));
const { loadEnvConfig } = vi.hoisted(() => ({ loadEnvConfig: vi.fn() }));
const { runForkedAgent } = vi.hoisted(() => ({ runForkedAgent: vi.fn() }));
const { vaultWrite } = vi.hoisted(() => ({ vaultWrite: vi.fn() }));

vi.mock("../db/user-model.ts", () => ({ getUserModel }));
vi.mock("../config/env.ts", () => ({ loadEnvConfig }));
vi.mock("../sdk/forked-agent.ts", () => ({ runForkedAgent }));
vi.mock("./vault.ts", () => ({ vaultWrite }));

import { writeRelationshipNarrative } from "./relationship-narrative.ts";

const fiveEntries = Array.from({ length: 5 }, (_, i) => ({
  category: "c",
  key: `k${i}`,
  value: `v${i}`,
  confidence: 0.8,
}));

describe("writeRelationshipNarrative", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadEnvConfig.mockReturnValue({ adaptiveMemory: true });
  });

  it("writes relationship.md from the learned model", async () => {
    getUserModel.mockResolvedValue(fiveEntries);
    runForkedAgent.mockResolvedValue({
      text: "You're a founder who ships fast and values integration tests. I've learned to lead with terse answers.",
    });
    const r = await writeRelationshipNarrative("u1");
    expect(r.wrote).toBe(true);
    expect(vaultWrite).toHaveBeenCalledWith(
      "u1",
      "relationship.md",
      expect.stringContaining("founder"),
      expect.anything(),
    );
  });

  it("no-ops when adaptive memory is off", async () => {
    loadEnvConfig.mockReturnValue({ adaptiveMemory: false });
    expect((await writeRelationshipNarrative("u1")).wrote).toBe(false);
    expect(runForkedAgent).not.toHaveBeenCalled();
  });

  it("no-ops with too little learned", async () => {
    getUserModel.mockResolvedValue(fiveEntries.slice(0, 3));
    expect((await writeRelationshipNarrative("u1")).wrote).toBe(false);
    expect(vaultWrite).not.toHaveBeenCalled();
  });
});
