import { vi, describe, it, expect, beforeEach } from "vitest";
import { createMockDb } from "../db/test-helpers.ts";

const { db, addResult, reset } = createMockDb();
vi.mock("../db/client.ts", () => ({ getKysely: () => db }));

import { CronStore } from "./store.ts";

let store: CronStore;

beforeEach(() => {
  reset();
  store = new CronStore();
});

describe("recordRunStart", () => {
  it("inserts a run row and returns the id", async () => {
    addResult([]);
    const id = await store.recordRunStart("job-1", "daily-report", "cron:job-1:123");
    expect(id).toBeDefined();
    expect(typeof id).toBe("string");
  });
});

describe("recordRunEnd", () => {
  it("updates run with success", async () => {
    addResult([]);
    await store.recordRunEnd("run-1", true, 1500);
  });

  it("updates run with failure and error message", async () => {
    addResult([]);
    await store.recordRunEnd("run-1", false, 500, "timeout");
  });
});

describe("listRuns", () => {
  const fakeRun = {
    id: "run-1",
    job_id: "job-1",
    job_name: "daily-report",
    started_at: new Date(),
    finished_at: new Date(),
    success: true,
    error: null,
    duration_ms: 1200,
    session_key: "cron:job-1:123",
  };

  it("returns all runs with no filter", async () => {
    addResult([fakeRun]);
    const runs = await store.listRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0].jobId).toBe("job-1");
    expect(runs[0].success).toBe(true);
  });

  it("filters by jobId", async () => {
    addResult([fakeRun]);
    const runs = await store.listRuns({ jobId: "job-1" });
    expect(runs).toHaveLength(1);
  });

  it("filters by success status", async () => {
    addResult([]);
    const runs = await store.listRuns({ success: false });
    expect(runs).toEqual([]);
  });

  it("filters by jobId and success", async () => {
    addResult([fakeRun]);
    const runs = await store.listRuns({ jobId: "job-1", success: true });
    expect(runs).toHaveLength(1);
  });

  it("maps null fields to undefined", async () => {
    const runWithNulls = {
      ...fakeRun,
      finished_at: null,
      error: null,
      duration_ms: null,
      session_key: null,
    };
    addResult([runWithNulls]);
    const runs = await store.listRuns();
    expect(runs[0].finishedAt).toBeUndefined();
    expect(runs[0].error).toBeUndefined();
    expect(runs[0].durationMs).toBeUndefined();
    expect(runs[0].sessionKey).toBeUndefined();
  });
});

describe("getRunStats", () => {
  it("returns aggregated stats", async () => {
    addResult([
      {
        total: 10,
        successes: 8,
        failures: 2,
        avg_duration: 1500,
        last_run: new Date(),
      },
    ]);
    const stats = await store.getRunStats("job-1");
    expect(stats.totalRuns).toBe(10);
    expect(stats.successCount).toBe(8);
    expect(stats.failureCount).toBe(2);
    expect(stats.avgDurationMs).toBe(1500);
    expect(stats.lastRun).toBeInstanceOf(Date);
  });
});

describe("pruneOldRuns", () => {
  it("deletes old runs and returns count", async () => {
    addResult([{}, {}, {}, {}, {}]); // 5 rows deleted
    const deleted = await store.pruneOldRuns(30);
    expect(deleted).toBe(5);
  });
});
