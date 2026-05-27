/**
 * Distributed lease (mutex) backed by Redis.
 *
 * `withLease(name, ttlSec, fn)` acquires a Redis lock with a TTL, runs `fn`,
 * auto-renews the lease every `ttlSec/3` seconds while `fn` runs, and
 * releases on completion. If the lock is held by another process,
 * `withLease` returns `null` without running `fn`.
 *
 * Replaces all `~/.nomos/*.lock` file-based locks. Survives pod restarts:
 * the TTL ensures the lease eventually frees up even if the holder crashes.
 */

import { randomUUID } from "node:crypto";
import { createLogger } from "../lib/logger.ts";
import { getRedis, keyFor, isRedisConfigured } from "./redis.ts";

const log = createLogger("leases");

const RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

const RENEW_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("pexpire", KEYS[1], ARGV[2])
else
  return 0
end
`;

export interface LeaseOptions {
  /** Lease TTL in seconds. Default 60. */
  ttlSec?: number;
  /** Renew interval in milliseconds. Default ttlSec * 1000 / 3. */
  renewIntervalMs?: number;
}

/**
 * Try to acquire the lease and run `fn`. Returns the result of `fn`, or
 * `null` if the lock was held by another process.
 *
 * Releases automatically on completion or throw. Auto-renews the TTL while
 * `fn` is running so long-running tasks don't lose the lease.
 */
export async function withLease<T>(
  name: string,
  fn: () => Promise<T>,
  opts: LeaseOptions = {},
): Promise<T | null> {
  if (!isRedisConfigured()) {
    log.warn({ name }, "Redis not configured, running without lease");
    return await fn();
  }

  const ttlSec = opts.ttlSec ?? 60;
  const renewIntervalMs = opts.renewIntervalMs ?? Math.floor((ttlSec * 1000) / 3);
  const key = keyFor("lease", name);
  const token = randomUUID();
  const redis = getRedis();

  const acquired = await redis.set(key, token, "EX", ttlSec, "NX");
  if (acquired !== "OK") {
    log.debug({ name }, "Lease held by another process");
    return null;
  }

  log.debug({ name, ttlSec }, "Lease acquired");

  const renewTimer = setInterval(async () => {
    try {
      const result = (await redis.eval(
        RENEW_SCRIPT,
        1,
        key,
        token,
        String(ttlSec * 1000),
      )) as number;
      if (result === 0) {
        log.warn({ name }, "Lease lost during renewal — another holder took it");
      }
    } catch (err) {
      log.error({ err, name }, "Lease renewal failed");
    }
  }, renewIntervalMs);

  try {
    const result = await fn();
    return result;
  } finally {
    clearInterval(renewTimer);
    try {
      await redis.eval(RELEASE_SCRIPT, 1, key, token);
      log.debug({ name }, "Lease released");
    } catch (err) {
      log.error({ err, name }, "Lease release failed");
    }
  }
}

/**
 * Best-effort release for graceful shutdown. Releases any known leases
 * held in this process by calling the release script for each name.
 *
 * For named leases tracked elsewhere; `withLease` already releases on
 * completion, so this is only needed if you exit mid-execution.
 */
export async function releaseAll(names: string[]): Promise<void> {
  if (!isRedisConfigured()) return;
  const redis = getRedis();
  for (const name of names) {
    try {
      await redis.del(keyFor("lease", name));
    } catch {
      // Best effort
    }
  }
}
