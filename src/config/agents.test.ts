import { describe, expect, it } from "vitest";
import { getActiveAgent, type AgentConfig } from "./agents.ts";

// Note: loadAgentConfigs() reads from the filesystem, so we test its
// default-fallback behaviour by importing it directly (no agents.json
// file is expected to exist in the test environment).

describe("loadAgentConfigs", () => {
  it("returns default agent when no file exists", async () => {
    // Dynamic import so the module-level fs reads happen at import time
    const { loadAgentConfigs } = await import("./agents.ts");
    const agents = loadAgentConfigs();
    expect(agents).toEqual([{ id: "default", name: "Default" }]);
  });
});

describe("getActiveAgent", () => {
  const agents: AgentConfig[] = [
    { id: "alpha", name: "Alpha Agent", model: "claude-sonnet-4-6" },
    { id: "beta", name: "Beta Agent" },
  ];

  it("returns first agent when no ID given", () => {
    const result = getActiveAgent(agents);
    expect(result).toEqual(agents[0]);
  });

  it("returns matching agent by ID", () => {
    const result = getActiveAgent(agents, "beta");
    expect(result).toEqual(agents[1]);
  });

  it("returns first agent when ID not found", () => {
    const result = getActiveAgent(agents, "nonexistent");
    expect(result).toEqual(agents[0]);
  });
});
