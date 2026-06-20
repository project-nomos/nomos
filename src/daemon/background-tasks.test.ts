import { beforeEach, describe, expect, it } from "vitest";
import {
  type BackgroundTask,
  buildResumePrompt,
  getBackgroundTaskStore,
  InProcessBackgroundTaskStore,
  runBackgroundWatchSweep,
  setBackgroundTaskStore,
} from "./background-tasks.ts";

const SESSION = {
  sessionKey: "slack:C123",
  platform: "slack",
  channelId: "C123",
  userId: "local",
};

beforeEach(() => {
  // Fresh store per test so tasks don't leak between cases.
  setBackgroundTaskStore(new InProcessBackgroundTaskStore());
});

describe("background-tasks: watch → resume bridge (the wait-and-resume core)", () => {
  it("settles a completed task and enqueues a resume to the SAME session with the result", async () => {
    const store = getBackgroundTaskStore();
    await store.register({
      ...SESSION,
      kind: "ci",
      summary: "deploy CI run",
      watch: "echo CI_GREEN", // exit 0 => settled, stdout is the result
    });

    const resumed: BackgroundTask[] = [];
    const out = await runBackgroundWatchSweep(async (t) => {
      resumed.push(t);
    });

    expect(out).toEqual({ checked: 1, settled: 1 });
    expect(resumed).toHaveLength(1);
    expect(resumed[0].sessionKey).toBe(SESSION.sessionKey); // resumes the original thread
    expect(resumed[0].status).toBe("completed");
    expect(resumed[0].result).toContain("CI_GREEN");
    // The task is no longer pending, so a second sweep does NOT re-fire (idempotent).
    expect(await store.listPending()).toHaveLength(0);
  });

  it("NEGATIVE CONTROL: a not-yet-done task produces no resume and stays pending", async () => {
    const store = getBackgroundTaskStore();
    await store.register({
      ...SESSION,
      kind: "ci",
      summary: "still-running CI",
      watch: "exit 1", // nonzero => not settled yet
    });

    const resumed: BackgroundTask[] = [];
    const out = await runBackgroundWatchSweep(async (t) => {
      resumed.push(t);
    });

    expect(out).toEqual({ checked: 1, settled: 0 });
    expect(resumed).toHaveLength(0); // no phantom resume
    expect(await store.listPending()).toHaveLength(1); // still watched
  });

  it("a sweep settles only the ready tasks and re-checks the rest next time", async () => {
    const store = getBackgroundTaskStore();
    await store.register({ ...SESSION, kind: "ci", summary: "done", watch: "echo DONE" });
    await store.register({ ...SESSION, kind: "ci", summary: "pending", watch: "exit 3" });

    const resumed: BackgroundTask[] = [];
    const first = await runBackgroundWatchSweep(async (t) => void resumed.push(t));
    expect(first).toEqual({ checked: 2, settled: 1 });
    expect(resumed.map((t) => t.summary)).toEqual(["done"]);

    // Second sweep: only the still-pending one is checked, still not done.
    const second = await runBackgroundWatchSweep(async () => {});
    expect(second).toEqual({ checked: 1, settled: 0 });
  });

  it("a thrown resume-enqueue does not crash the sweep or wedge other tasks", async () => {
    const store = getBackgroundTaskStore();
    await store.register({ ...SESSION, kind: "ci", summary: "a", watch: "echo A" });
    await store.register({ ...SESSION, kind: "ci", summary: "b", watch: "echo B" });

    const seen: string[] = [];
    const out = await runBackgroundWatchSweep(async (t) => {
      seen.push(t.summary);
      if (t.summary === "a") throw new Error("delivery boom");
    });
    // Both checked + marked settled; "a" failed to enqueue but didn't stop "b".
    expect(out.checked).toBe(2);
    expect(seen.sort()).toEqual(["a", "b"]);
    expect(await store.listPending()).toHaveLength(0);
  });

  it("pendingForSession scopes to one conversation (for false-'done' hold-back)", async () => {
    const store = getBackgroundTaskStore();
    await store.register({ ...SESSION, kind: "ci", summary: "mine", watch: "exit 1" });
    await store.register({
      ...SESSION,
      sessionKey: "slack:OTHER",
      channelId: "OTHER",
      kind: "ci",
      summary: "theirs",
      watch: "exit 1",
    });
    expect(await store.pendingForSession(SESSION.sessionKey)).toHaveLength(1);
    expect(await store.pendingForSession("slack:OTHER")).toHaveLength(1);
  });

  it("buildResumePrompt carries the summary and the captured result", () => {
    const task = {
      ...SESSION,
      id: "t1",
      kind: "ci",
      summary: "nightly build",
      watch: "echo x",
      status: "completed" as const,
      result: "done: failure (2 tests broke)",
      createdAt: 0,
    };
    const p = buildResumePrompt(task);
    expect(p).toContain("nightly build");
    expect(p).toContain("done: failure (2 tests broke)");
    expect(p.toLowerCase()).toContain("continue");
  });
});
