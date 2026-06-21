/**
 * Live (held-open) streaming sessions — Layer A of wait-and-resume.
 *
 * Default daemon turns run one-shot: `runSession({ prompt: string })`, drain to
 * `result`, drop the handle. That re-warms the SDK every turn and can't resume a
 * session in-process. Layer A instead holds ONE streaming session open per
 * sessionKey: `runSession({ prompt: AsyncIterable<SDKUserMessage> })` whose
 * generator stays alive, and each turn (a normal user message OR a background-task
 * resume) is PUSHED into the live loop — in-context, zero warmup.
 *
 * This manager is generic: it owns the channel, the consumer loop, per-turn
 * emit/result coordination, and the idle/cap lifecycle. The SDK-message → event
 * logic is supplied by the caller (`AgentRuntime.handleSdkMessage`), so there is
 * exactly one drain implementation and no import cycle. Gated behind
 * `NOMOS_LIVE_SESSIONS`; off by default, so the one-shot path is untouched.
 *
 * Per-session turns are serialized by the daemon's MessageQueue, so a session has
 * at most one active turn at a time — the coordination here relies on that.
 */

import { createLogger } from "../lib/logger.ts";
import {
  runSession,
  type Query,
  type RunSessionParams,
  type SDKMessage,
  type SDKUserMessage,
} from "../sdk/session.ts";
import type { AgentEvent } from "./types.ts";
import { AssistantText } from "./assistant-text.ts";

const log = createLogger("live-session");

/** Accumulated result of one turn within a live session. */
export interface LiveTurnState {
  /** Per-UUID assistant-text accumulator (supports refusal-fallback eviction). */
  text: AssistantText;
  sessionId?: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

export function newTurnState(): LiveTurnState {
  return {
    text: new AssistantText(),
    sessionId: undefined,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
  };
}

/** Handle one SDK message: mutate `state`, `emit` client events, return true on turn-over (`result`). */
export type SdkMessageHandler = (
  msg: SDKMessage,
  emit: (e: AgentEvent) => void,
  state: LiveTurnState,
  sessionKey: string,
) => boolean;

function userMsg(text: string): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
  } as SDKUserMessage;
}

/** Host-owned prompt channel: push messages into a live streaming session. */
class PromptChannel implements AsyncIterable<SDKUserMessage> {
  private buf: SDKUserMessage[] = [];
  private waiters: ((r: IteratorResult<SDKUserMessage>) => void)[] = [];
  private closed = false;

  push(text: string): void {
    const m = userMsg(text);
    const w = this.waiters.shift();
    if (w) w({ value: m, done: false });
    else this.buf.push(m);
  }
  close(): void {
    this.closed = true;
    const w = this.waiters.shift();
    if (w) w({ value: undefined as never, done: true });
  }
  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        if (this.buf.length) return Promise.resolve({ value: this.buf.shift()!, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((res) => this.waiters.push(res));
      },
    };
  }
}

class LiveSession {
  private channel = new PromptChannel();
  private currentEmit: ((e: AgentEvent) => void) | null = null;
  private currentResolve: ((s: LiveTurnState) => void) | null = null;
  private currentReject: ((e: Error) => void) | null = null;
  private state = newTurnState();
  private closed = false;
  private readonly query: Query;
  turns = 0;
  lastActive = Date.now();

  constructor(
    private readonly sessionKey: string,
    params: RunSessionParams,
    private readonly handle: SdkMessageHandler,
  ) {
    // Start the streaming query with our channel as the prompt; drain forever.
    this.query = runSession({ ...params, prompt: this.channel });
    void this.consume(this.query as AsyncIterable<SDKMessage>);
  }

  /**
   * D.2 — gracefully interrupt the turn currently in flight on this held-open
   * session (the SDK ends it with a result; the session stays open for the next
   * turn). No-op when idle.
   */
  interrupt(): void {
    void this.query.interrupt?.();
  }

  private async consume(query: AsyncIterable<SDKMessage>): Promise<void> {
    try {
      for await (const msg of query) {
        const emit = this.currentEmit ?? (() => {});
        const isTurnOver = this.handle(msg, emit, this.state, this.sessionKey);
        if (isTurnOver) {
          const resolve = this.currentResolve;
          const finished = { ...this.state };
          this.currentResolve = null;
          this.currentReject = null;
          this.currentEmit = null;
          // Reset the per-turn accumulator, carrying the SDK session id forward.
          this.state = { ...newTurnState(), sessionId: finished.sessionId };
          resolve?.(finished);
        }
      }
    } catch (err) {
      const reject = this.currentReject;
      this.currentResolve = null;
      this.currentReject = null;
      reject?.(err instanceof Error ? err : new Error(String(err)));
    } finally {
      this.closed = true;
    }
  }

  /** Push one turn into the live loop and await its result. */
  runTurn(content: string, emit: (e: AgentEvent) => void): Promise<LiveTurnState> {
    if (this.closed) return Promise.reject(new Error("live session closed"));
    this.turns++;
    this.lastActive = Date.now();
    return new Promise<LiveTurnState>((resolve, reject) => {
      this.currentEmit = emit;
      this.currentResolve = resolve;
      this.currentReject = reject;
      this.channel.push(content);
    });
  }

  close(): void {
    this.closed = true;
    this.channel.close();
  }
  get isClosed(): boolean {
    return this.closed;
  }
}

export class LiveSessionManager {
  private sessions = new Map<string, LiveSession>();
  private readonly maxSessions: number;
  private readonly idleMs: number;
  private sweepTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly handle: SdkMessageHandler,
    opts: { maxSessions?: number; idleMs?: number } = {},
  ) {
    this.maxSessions = opts.maxSessions ?? 20;
    this.idleMs = opts.idleMs ?? 5 * 60 * 1000;
  }

  /** Run one turn for `sessionKey` in a held-open streaming session (creating it if needed). */
  async runTurn(
    sessionKey: string,
    params: RunSessionParams,
    emit: (e: AgentEvent) => void,
  ): Promise<LiveTurnState> {
    let s = this.sessions.get(sessionKey);
    if (s?.isClosed) {
      this.sessions.delete(sessionKey);
      s = undefined;
    }
    if (!s) {
      this.evictIfNeeded();
      s = new LiveSession(sessionKey, params, this.handle);
      this.sessions.set(sessionKey, s);
      log.info({ sessionKey, live: this.sessions.size }, "opened live session");
    }
    this.ensureSweep();
    const content = typeof params.prompt === "string" ? params.prompt : "";
    try {
      return await s.runTurn(content, emit);
    } catch (err) {
      // A failed live turn drops the session so the next turn re-opens cleanly.
      s.close();
      this.sessions.delete(sessionKey);
      throw err;
    }
  }

  hasLive(sessionKey: string): boolean {
    const s = this.sessions.get(sessionKey);
    return Boolean(s && !s.isClosed);
  }
  /** D.2 — interrupt the in-flight turn on a held-open session; true if one was live. */
  interrupt(sessionKey: string): boolean {
    const s = this.sessions.get(sessionKey);
    if (!s || s.isClosed) return false;
    s.interrupt();
    return true;
  }
  turnCount(sessionKey: string): number {
    return this.sessions.get(sessionKey)?.turns ?? 0;
  }
  get size(): number {
    return this.sessions.size;
  }

  private evictIfNeeded(): void {
    if (this.sessions.size < this.maxSessions) return;
    let oldestKey: string | undefined;
    let oldest = Infinity;
    for (const [k, s] of this.sessions) {
      if (s.lastActive < oldest) {
        oldest = s.lastActive;
        oldestKey = k;
      }
    }
    if (oldestKey) {
      this.sessions.get(oldestKey)?.close();
      this.sessions.delete(oldestKey);
    }
  }

  private ensureSweep(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => this.sweepIdle(), 60_000);
    this.sweepTimer.unref?.();
  }
  private sweepIdle(): void {
    const now = Date.now();
    for (const [k, s] of this.sessions) {
      if (s.isClosed || now - s.lastActive > this.idleMs) {
        s.close();
        this.sessions.delete(k);
      }
    }
  }

  closeAll(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    for (const s of this.sessions.values()) s.close();
    this.sessions.clear();
  }
}
