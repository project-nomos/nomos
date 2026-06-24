import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CronScheduler, parseInterval, nextCronRun } from "./scheduler.ts";
import type { CronJob } from "./types.ts";

describe("parseInterval", () => {
  it("parses seconds", () => {
    expect(parseInterval("30s")).toBe(30_000);
  });

  it("parses minutes", () => {
    expect(parseInterval("5m")).toBe(5 * 60_000);
  });

  it("parses hours", () => {
    expect(parseInterval("2h")).toBe(2 * 60 * 60_000);
  });

  it("parses days", () => {
    expect(parseInterval("1d")).toBe(24 * 60 * 60_000);
  });

  it("throws on invalid format — missing unit", () => {
    expect(() => parseInterval("30")).toThrow("Invalid interval format");
  });

  it("throws on invalid format — unknown unit", () => {
    expect(() => parseInterval("30x")).toThrow("Invalid interval format");
  });

  it("throws on invalid format — empty string", () => {
    expect(() => parseInterval("")).toThrow("Invalid interval format");
  });

  it("throws on invalid format — letters only", () => {
    expect(() => parseInterval("abc")).toThrow("Invalid interval format");
  });
});

describe("nextCronRun", () => {
  it("returns a future Date for valid cron expression", () => {
    const result = nextCronRun("*/5 * * * *"); // every 5 minutes
    expect(result).toBeInstanceOf(Date);
    expect(result.getTime()).toBeGreaterThan(Date.now());
  });

  it("throws on invalid cron expression", () => {
    expect(() => nextCronRun("not a cron")).toThrow("Invalid cron expression");
  });

  it("handles standard cron expressions", () => {
    const result = nextCronRun("0 9 * * 1"); // 9 AM every Monday
    expect(result).toBeInstanceOf(Date);
    expect(result.getTime()).toBeGreaterThan(Date.now());
  });
});

describe("CronScheduler 'every' jobs survive the 60s reschedule poll", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function everyJob(schedule: string): CronJob {
    return {
      id: "j1",
      userId: "local",
      name: "interval-job",
      schedule,
      scheduleType: "every",
      sessionTarget: "isolated",
      deliveryMode: "none",
      prompt: "x",
      enabled: true,
      errorCount: 0,
      createdAt: new Date(), // fake-clock base, since useFakeTimers ran first
    };
  }

  // Regression: `scheduleJobs()` re-runs every 60s. Previously `every` returned
  // `now + interval`, so any interval >= 60s had its timer reset before it could
  // elapse and the job NEVER fired (only `cron` jobs ran in prod).
  it("fires a 5m interval job despite the timer being rescheduled each minute", async () => {
    const fired: string[] = [];
    const sched = new CronScheduler([everyJob("5m")], async (j) => {
      fired.push(j.id);
    });
    sched.start();
    // Advance 6 minutes one minute at a time (the poll fires every minute).
    for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(60_000);
    sched.stop();
    expect(fired.length).toBeGreaterThanOrEqual(1);
  });

  it("keeps firing on each interval (not just once)", async () => {
    const fired: string[] = [];
    const sched = new CronScheduler([everyJob("5m")], async (j) => {
      fired.push(j.id);
    });
    sched.start();
    for (let i = 0; i < 16; i++) await vi.advanceTimersByTimeAsync(60_000); // ~16 min
    sched.stop();
    expect(fired.length).toBeGreaterThanOrEqual(2);
  });
});
