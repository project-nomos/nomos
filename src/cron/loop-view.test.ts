import { describe, it, expect } from "vitest";
import { curateConsumerLoops, prettifySchedule, MANAGED_LABEL_TO_NAME } from "./loop-view.ts";
import type { CronJob } from "./types.ts";

function job(p: Partial<CronJob>): CronJob {
  return {
    id: p.id ?? p.name ?? "id",
    userId: p.userId ?? "system",
    name: p.name ?? "job",
    schedule: p.schedule ?? "6h",
    scheduleType: p.scheduleType ?? "every",
    sessionTarget: "isolated",
    deliveryMode: "none",
    prompt: p.prompt ?? "",
    enabled: p.enabled ?? true,
    errorCount: p.errorCount ?? 0,
    lastRun: p.lastRun,
    createdAt: new Date(0),
    source: p.source,
  };
}

// Mirrors the live customer DB: 4 system loops + bundled examples (owned by
// "local", so absent from both partitions) + agent-created loops.
const SYSTEM = [
  job({ name: "auto-dream", schedule: "6h", source: "system" }),
  job({ name: "style-analyze", schedule: "24h", source: "system" }),
  job({ name: "graph-semantic", schedule: "6h", source: "system" }),
  job({ name: "magic-docs-refresh", schedule: "1h", source: "system" }),
  job({ name: "wiki-compile", schedule: "2h", source: "system" }),
  job({
    name: "proactive:morning-briefing",
    schedule: "0 8 * * *",
    scheduleType: "cron",
    source: "system",
  }),
];

describe("curateConsumerLoops", () => {
  it("surfaces only the managed system loops under friendly labels", () => {
    const out = curateConsumerLoops(SYSTEM, new Set());
    const names = out.map((l) => l.name);
    expect(names).toEqual(["Brain consolidation", "Writing style learning"]);
    // Infra plumbing + proactive family are hidden.
    for (const hidden of [
      "graph-semantic",
      "magic-docs-refresh",
      "wiki-compile",
      "proactive:morning-briefing",
    ]) {
      expect(names).not.toContain(hidden);
    }
  });

  it("marks managed loops source=managed so the client renders a toggle", () => {
    const out = curateConsumerLoops(SYSTEM, new Set());
    expect(out.every((l) => l.source === "managed")).toBe(true);
  });

  it("folds the per-user opt-out into enabled without mutating the row", () => {
    const on = curateConsumerLoops(SYSTEM, new Set());
    expect(on.find((l) => l.name === "Brain consolidation")?.enabled).toBe(true);

    const off = curateConsumerLoops(SYSTEM, new Set(["auto-dream"]));
    expect(off.find((l) => l.name === "Brain consolidation")?.enabled).toBe(false);
    // The other managed loop is unaffected.
    expect(off.find((l) => l.name === "Writing style learning")?.enabled).toBe(true);
  });

  it("a disabled system row reads disabled even without an opt-out", () => {
    const out = curateConsumerLoops(
      [job({ name: "auto-dream", source: "system", enabled: false })],
      new Set(),
    );
    expect(out.find((l) => l.name === "Brain consolidation")?.enabled).toBe(false);
  });

  it("does not surface user/agent jobs (those are the Tasks surface)", () => {
    const out = curateConsumerLoops(
      [job({ name: "weekly-report", source: "agent", userId: "ba_user" })],
      new Set(),
    );
    // Only managed system loops by name are surfaced; an agent job is not managed.
    expect(out).toHaveLength(0);
  });

  it("round-trips managed friendly labels back to real job names for toggling", () => {
    expect(MANAGED_LABEL_TO_NAME.get("Brain consolidation")).toBe("auto-dream");
    expect(MANAGED_LABEL_TO_NAME.get("Writing style learning")).toBe("style-analyze");
  });
});

describe("prettifySchedule", () => {
  it("renders 'every' cadences", () => {
    expect(prettifySchedule("6h", "every")).toBe("Every 6 hours");
    expect(prettifySchedule("1h", "every")).toBe("Hourly");
    expect(prettifySchedule("24h", "every")).toBe("Daily");
    expect(prettifySchedule("15m", "every")).toBe("Every 15 minutes");
  });

  it("renders daily + weekday/weekly/monthly cron expressions", () => {
    expect(prettifySchedule("0 8 * * *", "cron")).toBe("Daily at 8:00 AM");
    expect(prettifySchedule("30 17 * * *", "cron")).toBe("Daily at 5:30 PM");
    expect(prettifySchedule("0 9 * * 1-5", "cron")).toBe("Weekdays at 9:00 AM");
    expect(prettifySchedule("0 9 * * 1", "cron")).toBe("Weekly on Mon at 9:00 AM");
    expect(prettifySchedule("0 8 15 * *", "cron")).toBe("Monthly on day 15 at 8:00 AM");
  });

  it("falls back to the raw string for genuinely unrecognized shapes", () => {
    expect(prettifySchedule("*/5 * * * *", "cron")).toBe("*/5 * * * *");
    expect(prettifySchedule("0 9 1 1 *", "cron")).toBe("0 9 1 1 *"); // specific month, not modeled
  });
});
