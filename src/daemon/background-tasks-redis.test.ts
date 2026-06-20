import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeRedis, getRedis, keyFor } from "../storage/redis.ts";
import {
  type BackgroundTask,
  runBackgroundWatchSweep,
  setBackgroundTaskStore,
} from "./background-tasks.ts";
import { RedisBackgroundTaskStore } from "./background-tasks-redis.ts";

// Runs only when Redis is configured (the hosted substrate). Skipped in CI where
// REDIS_URL is unset — power-user uses the in-process store (covered separately).
const HAVE_REDIS = Boolean(process.env.REDIS_URL);
if (HAVE_REDIS) process.env.NOMOS_ORG_ID = "bgtask-redis-test"; // isolate this suite's keys

const SESSION = { sessionKey: "slack:C1", platform: "slack", channelId: "C1", userId: "local" };

async function flushTestKeys(): Promise<void> {
  const redis = getRedis();
  const keys = await redis.keys(keyFor("*"));
  if (keys.length) await redis.del(...keys);
}

describe.skipIf(!HAVE_REDIS)("RedisBackgroundTaskStore (hosted substrate, live Redis)", () => {
  const store = new RedisBackgroundTaskStore();

  beforeEach(flushTestKeys);
  afterAll(async () => {
    await flushTestKeys();
    await closeRedis();
  });

  it("register -> listPending -> get round-trips through Redis", async () => {
    const t = await store.register({ ...SESSION, kind: "ci", summary: "deploy", watch: "echo X" });
    expect((await store.listPending()).map((p) => p.id)).toContain(t.id);
    const got = await store.get(t.id);
    expect(got?.summary).toBe("deploy");
    expect(got?.status).toBe("pending");
  });

  it("markSettled removes from pending and stamps the result", async () => {
    const t = await store.register({ ...SESSION, kind: "ci", summary: "s", watch: "echo X" });
    await store.markSettled(t.id, "completed", "done: success");
    expect(await store.listPending()).toHaveLength(0);
    const got = await store.get(t.id);
    expect(got?.status).toBe("completed");
    expect(got?.result).toBe("done: success");
  });

  it("pendingForSession scopes by conversation", async () => {
    await store.register({ ...SESSION, kind: "ci", summary: "mine", watch: "echo X" });
    await store.register({
      ...SESSION,
      sessionKey: "slack:OTHER",
      channelId: "OTHER",
      kind: "ci",
      summary: "theirs",
      watch: "echo X",
    });
    expect(await store.pendingForSession(SESSION.sessionKey)).toHaveLength(1);
    expect(await store.pendingForSession("slack:OTHER")).toHaveLength(1);
  });

  it("END-TO-END: the watcher resumes the original session off the Redis store", async () => {
    setBackgroundTaskStore(store);
    await store.register({ ...SESSION, kind: "ci", summary: "CI run", watch: "echo CI_GREEN" });

    const resumed: BackgroundTask[] = [];
    const out = await runBackgroundWatchSweep(async (task) => void resumed.push(task));

    expect(out).toEqual({ checked: 1, settled: 1 });
    expect(resumed).toHaveLength(1);
    expect(resumed[0].sessionKey).toBe(SESSION.sessionKey);
    expect(resumed[0].result).toContain("CI_GREEN");
    // Settled => no longer pending in Redis; a second sweep is a no-op (idempotent).
    expect(await store.listPending()).toHaveLength(0);
    expect((await runBackgroundWatchSweep(async (task) => void resumed.push(task))).settled).toBe(
      0,
    );
  });
});
