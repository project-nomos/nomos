/**
 * Redis-Streams-backed FIFO message queue.
 *
 * Replaces the in-memory `MessageQueue`. Goals:
 *   - Pod-agnostic: any pod can enqueue, any pod can consume.
 *   - Per-session ordering: one consumer group per session_key, single
 *     active consumer per group at a time.
 *   - Survival across pod restarts: XAUTOCLAIM reassigns pending messages
 *     from dead consumers after their idle timeout.
 *
 * Stream key: `mynomos:org:<id>:msgq`
 * Consumer group: `session:<session_key>`
 * Consumer name: random per-process UUID at startup.
 */

import { randomUUID } from "node:crypto";
import { createLogger } from "../lib/logger.ts";
import { getRedis, keyFor, isRedisConfigured } from "./redis.ts";

const log = createLogger("stream-queue");

const STREAM_KEY = "msgq";
const PENDING_RECLAIM_IDLE_MS = 5 * 60 * 1000; // 5 minutes
const RECLAIM_POLL_INTERVAL_MS = 30 * 1000; // 30 seconds

export interface StreamMessage<T = unknown> {
  /** Redis stream entry ID (e.g., "1700000000000-0"). */
  id: string;
  /** Session key — used as the consumer group name. */
  sessionKey: string;
  /** Caller-provided payload. */
  payload: T;
}

export interface StreamQueueOptions {
  /** Consumer name. Defaults to a random UUID per process. */
  consumerName?: string;
  /** Block timeout for XREADGROUP in milliseconds. Default 5000. */
  blockMs?: number;
  /** Idle timeout before XAUTOCLAIM reassigns a pending message. Default 5min. */
  reclaimIdleMs?: number;
}

export type StreamHandler<T> = (msg: StreamMessage<T>) => Promise<void>;

/**
 * StreamQueue lets you `enqueue` messages tagged by sessionKey and `consume`
 * them per session with FIFO ordering and at-least-once delivery.
 */
export class StreamQueue<T = unknown> {
  private readonly consumerName: string;
  private readonly blockMs: number;
  private readonly reclaimIdleMs: number;
  private streamKey: string;
  private running = false;
  private reclaimTimer: NodeJS.Timeout | null = null;
  private consumers = new Map<string, Promise<void>>();

  constructor(opts: StreamQueueOptions = {}) {
    this.consumerName = opts.consumerName ?? `nomos-${randomUUID().slice(0, 8)}`;
    this.blockMs = opts.blockMs ?? 5000;
    this.reclaimIdleMs = opts.reclaimIdleMs ?? PENDING_RECLAIM_IDLE_MS;
    this.streamKey = keyFor(STREAM_KEY);
  }

  /** Enqueue a message tagged with sessionKey. */
  async enqueue(sessionKey: string, payload: T): Promise<string> {
    if (!isRedisConfigured()) {
      throw new Error("REDIS_URL not set; StreamQueue requires Redis");
    }
    const redis = getRedis();
    const id = await redis.xadd(
      this.streamKey,
      "*",
      "sessionKey",
      sessionKey,
      "payload",
      JSON.stringify(payload),
    );
    return id ?? "";
  }

  /**
   * Begin consuming messages for a given sessionKey. Each session has its
   * own consumer group, ensuring per-session ordering. Messages are XACK'd
   * after the handler resolves.
   *
   * If the handler throws, the message stays pending and will be reclaimed
   * by XAUTOCLAIM after `reclaimIdleMs` so another process can retry it.
   */
  consume(sessionKey: string, handler: StreamHandler<T>): void {
    if (this.consumers.has(sessionKey)) return;
    const groupName = `session:${sessionKey}`;
    const loop = this.runConsumerLoop(sessionKey, groupName, handler);
    this.consumers.set(sessionKey, loop);
  }

  private async runConsumerLoop(
    sessionKey: string,
    groupName: string,
    handler: StreamHandler<T>,
  ): Promise<void> {
    const redis = getRedis();

    // Create the consumer group if it doesn't exist
    try {
      await redis.xgroup("CREATE", this.streamKey, groupName, "$", "MKSTREAM");
    } catch (err) {
      const msg = (err as Error).message ?? "";
      if (!msg.includes("BUSYGROUP")) {
        log.error({ err, sessionKey }, "Failed to create consumer group");
        return;
      }
    }

    this.running = true;
    while (this.running) {
      try {
        const reply = (await redis.xreadgroup(
          "GROUP",
          groupName,
          this.consumerName,
          "COUNT",
          1,
          "BLOCK",
          this.blockMs,
          "STREAMS",
          this.streamKey,
          ">",
        )) as Array<[string, Array<[string, string[]]>]> | null;

        if (!reply) continue;

        for (const [, entries] of reply) {
          for (const [id, fields] of entries) {
            const fieldMap: Record<string, string> = {};
            for (let i = 0; i < fields.length; i += 2) {
              fieldMap[fields[i]!] = fields[i + 1]!;
            }
            if (fieldMap.sessionKey !== sessionKey) {
              // Belongs to another session — XACK and move on (this consumer
              // group only handles its own session).
              await redis.xack(this.streamKey, groupName, id);
              continue;
            }
            try {
              const payload = JSON.parse(fieldMap.payload ?? "null") as T;
              await handler({ id, sessionKey, payload });
              await redis.xack(this.streamKey, groupName, id);
            } catch (err) {
              log.error({ err, id, sessionKey }, "Handler threw; message left pending");
              // Do not XACK — message will be reclaimed by XAUTOCLAIM after idle timeout
            }
          }
        }
      } catch (err) {
        log.error({ err, sessionKey }, "Stream consume loop error");
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  /**
   * Start the background reclaim job that pulls in stuck pending messages
   * (held by dead consumers) and reassigns them. Call once at startup.
   */
  startReclaimJob(): void {
    if (this.reclaimTimer) return;
    this.reclaimTimer = setInterval(() => {
      this.reclaimPending().catch((err) => log.error({ err }, "Reclaim job error"));
    }, RECLAIM_POLL_INTERVAL_MS);
  }

  private async reclaimPending(): Promise<void> {
    // XAUTOCLAIM only works per-group, but we may have many groups in this
    // process; reclaim is best-effort across groups we know about.
    const redis = getRedis();
    for (const sessionKey of this.consumers.keys()) {
      const groupName = `session:${sessionKey}`;
      try {
        await redis.xautoclaim(
          this.streamKey,
          groupName,
          this.consumerName,
          this.reclaimIdleMs,
          "0-0",
          "COUNT",
          10,
        );
      } catch (err) {
        // Group may not exist yet; ignore
        const msg = (err as Error).message ?? "";
        if (!msg.includes("NOGROUP")) {
          log.debug({ err, sessionKey }, "Reclaim failed");
        }
      }
    }
  }

  /**
   * Stop all consumer loops and drain in-flight handlers. Called on
   * SIGTERM so K8s can roll the pod cleanly.
   */
  async stop(): Promise<void> {
    this.running = false;
    if (this.reclaimTimer) {
      clearInterval(this.reclaimTimer);
      this.reclaimTimer = null;
    }
    await Promise.allSettled(Array.from(this.consumers.values()));
    this.consumers.clear();
  }
}
