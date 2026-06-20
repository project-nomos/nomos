/**
 * Queue abstraction + at-least-once idempotency guard (Phase 2 of wait-and-resume).
 *
 * The daemon has two message-queue substrates:
 *  - in-memory `MessageQueue` (power-user / single process), and
 *  - Redis-Streams `StreamQueue` (hosted, multi-pod, pod-agnostic + restart-survivable).
 *
 * They share the per-session-FIFO contract captured by `Queue`. The Redis path is
 * AT-LEAST-ONCE: XAUTOCLAIM redelivers a message whose consumer died mid-handle,
 * and a background-resume can be re-enqueued — so any consumer that drives an
 * agent turn MUST be idempotent or it will double-run the model. `MessageDedupe`
 * is the shared guard: claim a message id once; a redelivery of the same id is a
 * no-op. (The in-memory queue mints unique ids, so this is inert there and
 * load-bearing only on the Redis consumer.)
 */

import type { AgentEvent, IncomingMessage, OutgoingMessage } from "./types.ts";

/** The per-session-FIFO message queue contract both substrates satisfy. */
export interface Queue {
  /**
   * Enqueue a message for a session. The in-memory queue resolves with the
   * handler's result (request/response); the Redis queue is pod-agnostic and the
   * enqueuer does not await a cross-pod result — callers that need the result
   * (cron, the resume bridge, gRPC) run co-located with their consumer.
   */
  enqueue(
    sessionKey: string,
    message: IncomingMessage,
    emit: (event: AgentEvent) => void,
  ): Promise<OutgoingMessage>;
  readonly pendingMessageCount: number;
  readonly pendingSessionCount: number;
}

/**
 * Bounded-LRU idempotency guard for at-least-once delivery. `claim(id)` returns
 * true exactly once per id (the caller should process); subsequent deliveries of
 * the same id return false (skip). Bounded so memory can't grow without limit.
 */
export class MessageDedupe {
  private readonly seen = new Set<string>();
  private readonly order: string[] = [];

  constructor(private readonly max = 2000) {}

  /** True if this id is new (process it); false if already claimed (skip — redelivery). */
  claim(id: string): boolean {
    if (this.seen.has(id)) return false;
    this.seen.add(id);
    this.order.push(id);
    if (this.order.length > this.max) {
      const evicted = this.order.shift();
      if (evicted !== undefined) this.seen.delete(evicted);
    }
    return true;
  }

  has(id: string): boolean {
    return this.seen.has(id);
  }

  get size(): number {
    return this.seen.size;
  }
}
