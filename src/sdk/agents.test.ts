import { describe, it, expect, afterEach } from "vitest";
import {
  buildNativeAgents,
  nativeAgentsEnabled,
  legacyTeamEnabled,
  useNativeTeam,
} from "./agents.ts";

describe("native agents (Phase G)", () => {
  it("defines a team-worker and a read-only verifier", () => {
    const agents = buildNativeAgents();
    expect(Object.keys(agents).sort()).toEqual(["team-worker", "verifier"]);

    expect(agents["team-worker"].description).toMatch(/parallel/i);
    expect(agents["team-worker"].prompt.length).toBeGreaterThan(50);
    expect(agents["team-worker"].model).toBe("inherit");

    // The verifier must be read-only: no Write/Edit in its tool list.
    const vtools = agents.verifier.tools ?? [];
    expect(vtools).toContain("Read");
    expect(vtools).not.toContain("Write");
    expect(vtools).not.toContain("Edit");
    expect(agents.verifier.prompt).toMatch(/VERDICT/);
  });

  it("nativeAgentsEnabled reads NOMOS_NATIVE_AGENTS", () => {
    const prev = process.env.NOMOS_NATIVE_AGENTS;
    process.env.NOMOS_NATIVE_AGENTS = "true";
    expect(nativeAgentsEnabled()).toBe(true);
    process.env.NOMOS_NATIVE_AGENTS = "false";
    expect(nativeAgentsEnabled()).toBe(false);
    delete process.env.NOMOS_NATIVE_AGENTS;
    expect(nativeAgentsEnabled()).toBe(false);
    if (prev !== undefined) process.env.NOMOS_NATIVE_AGENTS = prev;
  });

  it("team mode uses the native path by default; NOMOS_LEGACY_TEAM forces legacy (G step 2)", () => {
    const prev = process.env.NOMOS_LEGACY_TEAM;
    delete process.env.NOMOS_LEGACY_TEAM;
    // teamMode on + no legacy flag → native team
    expect(useNativeTeam(true)).toBe(true);
    expect(legacyTeamEnabled()).toBe(false);
    // teamMode off → no native team regardless
    expect(useNativeTeam(false)).toBe(false);
    // legacy flag forces the hand-rolled path
    process.env.NOMOS_LEGACY_TEAM = "true";
    expect(legacyTeamEnabled()).toBe(true);
    expect(useNativeTeam(true)).toBe(false);
    if (prev !== undefined) process.env.NOMOS_LEGACY_TEAM = prev;
    else delete process.env.NOMOS_LEGACY_TEAM;
  });

  afterEach(() => {
    delete process.env.NOMOS_NATIVE_AGENTS;
    delete process.env.NOMOS_LEGACY_TEAM;
  });
});
