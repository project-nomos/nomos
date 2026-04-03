import { vi, describe, it, expect, beforeEach } from "vitest";
import { CronStore } from "./store.ts";

// Build a mock sql tagged-template function that also works as a callable
const createMockSql = () => {
  const fn = vi.fn();
  const sql = Object.assign(fn, { unsafe: vi.fn() });
  return sql;
};

let mockSql: ReturnType<typeof createMockSql>;
let store: CronStore;

beforeEach(() => {
  mockSql = createMockSql();
  store = new CronStore(mockSql as never);
});

describe("recordRunStart", () => {
  it("inserts a run row and returns the id", async () => {
    mockSql.mockResolvedValueOnce([]);
    const id = await store.recordRunStart("job-1", "daily-report", "cron:job-1:123");
    expect(id).toBeDefined();
    expect(typeof id).toBe("string");
    expect(mockSql).toHaveBeenCalled();
  });
});

describe("recordRunEnd", () => {
  it("updates run with success", async () => {
    mockSql.mockResolvedValueOnce([]);
    await store.recordRunEnd("run-1", true, 1500);
    expect(mockSql).toHaveBeenCalled();
  });

  it("updates run with failure and error message", async () => {
    mockSql.mockResolvedValueOnce([]);
    await store.recordRunEnd("run-1", false, 500, "timeout");
    expect(mockSql).toHaveBeenCalled();
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
    mockSql.mockResolvedValueOnce([fakeRun]);
    const runs = await store.listRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0].jobId).toBe("job-1");
    expect(runs[0].success).toBe(true);
  });

  it("filters by jobId", async () => {
    mockSql.mockResolvedValueOnce([fakeRun]);
    const runs = await store.listRuns({ jobId: "job-1" });
    expect(runs).toHaveLength(1);
  });

  it("filters by success status", async () => {
    mockSql.mockResolvedValueOnce([]);
    const runs = await store.listRuns({ success: false });
    expect(runs).toEqual([]);
  });

  it("filters by jobId and success", async () => {
    mockSql.mockResolvedValueOnce([fakeRun]);
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
    mockSql.mockResolvedValueOnce([runWithNulls]);
    const runs = await store.listRuns();
    expect(runs[0].finishedAt).toBeUndefined();
    expect(runs[0].error).toBeUndefined();
    expect(runs[0].durationMs).toBeUndefined();
    expect(runs[0].sessionKey).toBeUndefined();
  });
});

describe("getRunStats", () => {
  it("returns aggregated stats", async () => {
    mockSql.mockResolvedValueOnce([
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
    mockSql.mockResolvedValueOnce({ count: 5 });
    const deleted = await store.pruneOldRuns(30);
    expect(deleted).toBe(5);
  });
});
