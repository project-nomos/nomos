import { describe, it, expect } from "vitest";
import { curateConsumerTasks, prettifyTaskName, toConsumerTask } from "./task-view.ts";
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

describe("prettifyTaskName", () => {
  it("humanizes kebab/snake/camel slugs to Title Case", () => {
    expect(prettifyTaskName("call-dentist")).toBe("Call Dentist");
    expect(prettifyTaskName("water_plants")).toBe("Water Plants");
    expect(prettifyTaskName("checkUrgentEmails")).toBe("Check Urgent Emails");
  });

  it("leaves real prose alone (only capitalizes the first letter)", () => {
    expect(prettifyTaskName("Check my inbox")).toBe("Check my inbox");
    expect(prettifyTaskName("review the PR diff")).toBe("Review the PR diff");
  });

  it("is applied by toConsumerTask so both transports show a friendly name", () => {
    expect(toConsumerTask(job({ name: "call-dentist" })).name).toBe("Call Dentist");
  });
});

describe("curateConsumerTasks", () => {
  it("sorts enabled first, then alphabetical", () => {
    const out = curateConsumerTasks([
      job({ name: "zebra", enabled: true }),
      job({ name: "apple", enabled: false }),
      job({ name: "mango", enabled: true }),
    ]);
    expect(out.map((t) => t.name)).toEqual(["Mango", "Zebra", "Apple"]);
  });

  it("passes through user/agent-scheduled jobs", () => {
    const out = curateConsumerTasks([
      job({ name: "a", source: "agent" }),
      job({ name: "b", source: "user" }),
    ]);
    expect(out).toHaveLength(2);
  });

  it("hides infra loops (system/bundled) that share the owner's user_id in power-user mode", () => {
    const out = curateConsumerTasks([
      job({ name: "call-dentist", source: "agent" }),
      job({ name: "auto-dream", source: "system" }),
      job({ name: "calendar-prep", source: "bundled" }),
    ]);
    expect(out.map((t) => t.name)).toEqual(["Call Dentist"]);
  });
});

describe("prettifySchedule (shared)", () => {
  it("handles every / cron / at", () => {
    expect(prettifySchedule("1h", "every")).toBe("Hourly");
    expect(prettifySchedule("0 9 * * *", "cron")).toBe("Daily at 9:00 AM");
    expect(prettifySchedule("not-a-date", "at")).toBe("not-a-date");
  });
});
