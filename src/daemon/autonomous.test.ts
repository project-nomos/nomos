import { describe, it, expect } from "vitest";
import { loadAllLoops } from "./autonomous.ts";

// loadAllLoops reads the bundled autonomous/ dir (+ optional personal/project
// tiers). Run from the repo root, so the 6 bundled LOOP.md files are present.
describe("autonomous loops loader", () => {
  const loops = loadAllLoops();

  it("loads the bundled LOOP.md definitions", () => {
    expect(loops.length).toBeGreaterThanOrEqual(6);
  });

  it("includes the known bundled loops", () => {
    const names = new Set(loops.map((l) => l.name));
    for (const expected of [
      "calendar-prep",
      "calendar-upcoming",
      "digital-marketing",
      "email-triage",
      "memory-consolidation",
      "slack-digest",
    ]) {
      expect(names.has(expected)).toBe(true);
    }
  });

  it("parses every loop into a valid, schedulable shape", () => {
    for (const loop of loops) {
      expect(loop.name).toBeTruthy();
      expect(loop.schedule).toBeTruthy();
      expect(loop.scheduleType).toBe("cron");
      expect(["main", "isolated"]).toContain(loop.sessionTarget);
      expect(["none", "announce"]).toContain(loop.deliveryMode);
      expect(typeof loop.enabled).toBe("boolean");
      expect(loop.prompt.length).toBeGreaterThan(0);
    }
  });

  it("ships every bundled loop disabled by default (opt-in)", () => {
    expect(loops.every((l) => l.enabled === false)).toBe(true);
  });

  it("merges tiers without duplicate names (precedence dedup)", () => {
    const names = loops.map((l) => l.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
