/**
 * Shared Redis client. All keys are prefixed with `mynomos:org:<NOMOS_ORG_ID>:`
 * so a single Redis instance can safely serve many customer deployments.
 *
 * Set REDIS_URL to enable. When unset, hosted mode refuses to boot (Phase 0
 * requires Redis); power-user mode falls back to file-based locks.
 */

import { Redis as RedisClient } from "ioredis";
import { createLogger } from "../lib/logger.ts";

const log = createLogger("redis");

let client: RedisClient | null = null;

export interface RedisOptions {
  url?: string;
  orgId?: string;
}

function resolveOrgId(): string {
  return process.env.NOMOS_ORG_ID ?? "local";
}

function resolveUrl(): string | undefined {
  return process.env.REDIS_URL;
}

export function isRedisConfigured(): boolean {
  return Boolean(resolveUrl());
}

export function getRedis(): RedisClient {
  if (client) return client;

  const url = resolveUrl();
  if (!url) {
    throw new Error(
      "REDIS_URL is not set. Redis is required for stateless operations in hosted mode.",
    );
  }

  const instance = new RedisClient(url, {
    lazyConnect: false,
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    retryStrategy: (times: number) => Math.min(times * 200, 5000),
  });

  instance.on("error", (err: Error) => {
    log.error({ err }, "Redis client error");
  });

  instance.on("connect", () => {
    log.info({ url: url.replace(/:[^:@]+@/, ":***@") }, "Redis connected");
  });

  client = instance;
  return instance;
}

export function keyFor(...parts: string[]): string {
  const orgId = resolveOrgId();
  return ["mynomos", "org", orgId, ...parts].join(":");
}

export async function closeRedis(): Promise<void> {
  if (client) {
    await client.quit();
    client = null;
  }
}
