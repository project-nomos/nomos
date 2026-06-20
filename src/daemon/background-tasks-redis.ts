/**
 * Redis-backed background task store (HOSTED substrate).
 *
 * Power-user runs the in-process store (lost on restart, by design). Hosted runs
 * THIS: pending tasks live in Redis (per-org namespaced via `keyFor`) so they
 * survive a pod roll and any pod's watcher can see them. The watcher itself runs
 * under a Redis lease (`withLease("background-watch")`) so only one pod sweeps.
 *
 * Storage: one key per task (`bgtask:<id>`) + a pending-id SET index
 * (`bgtasks:pending`). Settled tasks get a TTL so storage stays bounded; the
 * index is the source of truth for `listPending`, self-healing past expiries.
 */

import { randomUUID } from "node:crypto";
import { getRedis, keyFor } from "../storage/redis.ts";
import type { BackgroundTask, BackgroundTaskStore, RegisterInput } from "./background-tasks.ts";

const SETTLED_TTL_SEC = 3600; // keep settled tasks ~1h for late reads, then expire

function taskKey(id: string): string {
  return keyFor("bgtask", id);
}
function pendingSetKey(): string {
  return keyFor("bgtasks", "pending");
}

export class RedisBackgroundTaskStore implements BackgroundTaskStore {
  async register(input: RegisterInput): Promise<BackgroundTask> {
    const task: BackgroundTask = {
      id: randomUUID(),
      status: "pending",
      createdAt: Date.now(),
      ...input,
    };
    await getRedis()
      .multi()
      .set(taskKey(task.id), JSON.stringify(task))
      .sadd(pendingSetKey(), task.id)
      .exec();
    return task;
  }

  async get(id: string): Promise<BackgroundTask | undefined> {
    const raw = await getRedis().get(taskKey(id));
    return raw ? (JSON.parse(raw) as BackgroundTask) : undefined;
  }

  async listPending(): Promise<BackgroundTask[]> {
    const redis = getRedis();
    const ids = await redis.smembers(pendingSetKey());
    if (ids.length === 0) return [];
    const raws = await redis.mget(ids.map(taskKey));
    const out: BackgroundTask[] = [];
    const stale: string[] = [];
    for (let i = 0; i < ids.length; i++) {
      const raw = raws[i];
      if (!raw) {
        stale.push(ids[i]); // key expired -> drop from the index (self-heal)
        continue;
      }
      const t = JSON.parse(raw) as BackgroundTask;
      if (t.status === "pending") out.push(t);
      else stale.push(ids[i]); // settled but still indexed -> clean up
    }
    if (stale.length > 0) await redis.srem(pendingSetKey(), ...stale);
    return out;
  }

  async markSettled(id: string, status: "completed" | "failed", result: string): Promise<void> {
    const redis = getRedis();
    const existing = await this.get(id);
    if (!existing) {
      await redis.srem(pendingSetKey(), id);
      return;
    }
    const settled: BackgroundTask = { ...existing, status, result, settledAt: Date.now() };
    await redis
      .multi()
      .set(taskKey(id), JSON.stringify(settled), "EX", SETTLED_TTL_SEC)
      .srem(pendingSetKey(), id)
      .exec();
  }

  async pendingForSession(sessionKey: string): Promise<BackgroundTask[]> {
    return (await this.listPending()).filter((t) => t.sessionKey === sessionKey);
  }
}
