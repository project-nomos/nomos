import { describe, it, expect } from "vitest";
import { curateConsumerTasks, toConsumerTask } from "./task-view.ts";
import { prettifySchedule } from "./schedule-format.ts";
import type { CronJob } from "./types.ts";

function job(p: Partial<CronJob>): CronJob {
  return {
    id: p.id ?? p.name ?? "id",
    userId: p.userId ?? "ba_user",
    name: p.name ?? "task",
    schedule: p.schedule ?? "15m",
    scheduleType: p.scheduleType ?? "every",
    sessionTarget: "isolated",
    deliveryMode: "none",
    prompt: p.prompt ?? "do the thing",
    enabled: p.enabled ?? true,
    errorCount: p.errorCount ?? 0,
    lastRun: p.lastRun,
    createdAt: new Date(0),
    source: p.source ?? "agent",
  };
}

describe("toConsumerTask", () => {
  it("carries the raw schedule + type AND a friendly display string", () => {
    const t = toConsumerTask(job({ name: "check-email", schedule: "15m", scheduleType: "every" }));
    expect(t.schedule).toBe("15m");
    expect(t.scheduleType).toBe("every");
    expect(t.displaySchedule).toBe("Every 15 minutes");
    expect(t.prompt).toBe("do the thing");
  });

  it("renders a one-off 'at' task time", () => {
    const t = toConsumerTask(job({ schedule: "2026-06-13T17:00:00Z", scheduleType: "at" }));
    expect(t.displaySchedule.startsWith("Once,")).toBe(true);
  });
});

describe("curateConsumerTasks", () => {
  it("sorts enabled first, then alphabetical", () => {
    const out = curateConsumerTasks([
      job({ name: "zebra", enabled: true }),
      job({ name: "apple", enabled: false }),
      job({ name: "mango", enabled: true }),
    ]);
    expect(out.map((t) => t.name)).toEqual(["mango", "zebra", "apple"]);
  });

  it("passes through every owned job (filtering is done by the per-user query)", () => {
    const out = curateConsumerTasks([job({ name: "a" }), job({ name: "b" })]);
    expect(out).toHaveLength(2);
  });
});

describe("prettifySchedule (shared)", () => {
  it("handles every / cron / at", () => {
    expect(prettifySchedule("1h", "every")).toBe("Hourly");
    expect(prettifySchedule("0 9 * * *", "cron")).toBe("Daily at 9:00 AM");
    expect(prettifySchedule("not-a-date", "at")).toBe("not-a-date");
  });
});
