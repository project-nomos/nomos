/**
 * Background task registry + watcher (Phase 1 of wait-and-resume).
 *
 * The agent registers long async work (CI, deploy, long build) via the
 * `background_register` tool; the daemon frees the turn, and a watcher (the
 * `__background_watch__` cron sentinel) polls each task's `watch` command. On
 * completion it enqueues a RESUME message back into the SAME session's queue, so
 * the agent picks the thread back up with the result — no dead-end "waiting…"
 * message and no silent drop.
 *
 * Substrate is mode-aware behind `BackgroundTaskStore`: this in-process store
 * serves the power-user / single-process daemon (a restart drops in-flight tasks,
 * which is the user's responsibility). Hosted multi-pod swaps in a Redis-backed
 * store + a leased watcher (Phase 2) behind the same interface, and the resume
 * rides whatever queue the daemon uses (in-memory MessageQueue / Redis StreamQueue).
 */

import { exec } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createLogger } from "../lib/logger.ts";
import { isRedisConfigured } from "../storage/redis.ts";
import { DiskBackgroundTaskStore } from "./background-tasks-disk.ts";
import { RedisBackgroundTaskStore } from "./background-tasks-redis.ts";

const log = createLogger("background-tasks");

export type BackgroundTaskStatus = "pending" | "completed" | "failed";

export interface BackgroundTask {
  id: string;
  /** The ORIGINAL conversation to resume when this settles (not an isolated key). */
  sessionKey: string;
  platform: string;
  channelId: string;
  userId: string;
  kind: string;
  summary: string;
  /**
   * Shell command run each sweep to check completion. Convention:
   *  - exit 0  => SETTLED; stdout is the result handed to the agent (which itself
   *    conveys pass/fail, e.g. "done: success" / "done: failure").
   *  - nonzero => not done yet; poll again next sweep.
   * e.g. `gh run view <id> --json status,conclusion -q 'if .status=="completed"
   *      then "done: \(.conclusion)" else error("running") end'`.
   */
  watch: string;
  status: BackgroundTaskStatus;
  result?: string;
  createdAt: number;
  settledAt?: number;
}

export type RegisterInput = Pick<
  BackgroundTask,
  "sessionKey" | "platform" | "channelId" | "userId" | "kind" | "summary" | "watch"
>;

export interface BackgroundTaskStore {
  register(input: RegisterInput): Promise<BackgroundTask>;
  listPending(): Promise<BackgroundTask[]>;
  get(id: string): Promise<BackgroundTask | undefined>;
  markSettled(id: string, status: "completed" | "failed", result: string): Promise<void>;
  /** Pending tasks for a session (used to hold back a false "done"). */
  pendingForSession(sessionKey: string): Promise<BackgroundTask[]>;
}

/** In-process store (power-user / single-process). Lost on restart by design. */
export class InProcessBackgroundTaskStore implements BackgroundTaskStore {
  private tasks = new Map<string, BackgroundTask>();

  async register(input: RegisterInput): Promise<BackgroundTask> {
    const task: BackgroundTask = {
      id: randomUUID(),
      status: "pending",
      createdAt: Date.now(),
      ...input,
    };
    this.tasks.set(task.id, task);
    return task;
  }

  async listPending(): Promise<BackgroundTask[]> {
    return [...this.tasks.values()].filter((t) => t.status === "pending");
  }

  async get(id: string): Promise<BackgroundTask | undefined> {
    return this.tasks.get(id);
  }

  async markSettled(id: string, status: "completed" | "failed", result: string): Promise<void> {
    const t = this.tasks.get(id);
    if (!t) return;
    t.status = status;
    t.result = result;
    t.settledAt = Date.now();
  }

  async pendingForSession(sessionKey: string): Promise<BackgroundTask[]> {
    return [...this.tasks.values()].filter(
      (t) => t.status === "pending" && t.sessionKey === sessionKey,
    );
  }
}

let store: BackgroundTaskStore | undefined;

export function getBackgroundTaskStore(): BackgroundTaskStore {
  if (!store) {
    // Substrate by mode: Redis (hosted — survives pod rolls + any pod's leased
    // watcher) > disk (power-user default — survives the upgrade restart) >
    // in-memory (opt-out via NOMOS_BACKGROUND_TASKS_DISK=false; also used in tests).
    store = isRedisConfigured()
      ? new RedisBackgroundTaskStore()
      : process.env.NOMOS_BACKGROUND_TASKS_DISK === "false"
        ? new InProcessBackgroundTaskStore()
        : new DiskBackgroundTaskStore();
  }
  return store;
}

/** Test/Phase-2 hook: swap the store (Redis impl in hosted, or a fresh one per test). */
export function setBackgroundTaskStore(s: BackgroundTaskStore): void {
  store = s;
}

const WATCH_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

export interface WatchOutcome {
  /** True once the task has settled (the watch command exited 0). */
  settled: boolean;
  /** Captured output handed to the agent on settle. */
  result: string;
}

export type WatchRunner = (cmd: string) => Promise<WatchOutcome>;

/** Run a task's `watch` command. exit 0 => settled (stdout is the result); nonzero => not done. */
export const runWatch: WatchRunner = (cmd) =>
  new Promise((resolve) => {
    exec(cmd, { timeout: WATCH_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES }, (err, stdout, stderr) => {
      const out = (stdout || "").trim() || (stderr || "").trim();
      // Non-zero exit (incl. timeout) => still pending; poll again next sweep.
      resolve({ settled: !err, result: out || "(no output)" });
    });
  });

export type EnqueueResume = (task: BackgroundTask) => Promise<void>;

/**
 * Poll every pending task; on settle, mark it and enqueue a resume turn. The
 * `__background_watch__` cron sentinel calls this with an `enqueueResume` that
 * builds an IncomingMessage from the task's stored session context and pushes it
 * into the session's queue. `check` is injectable for tests.
 */
export async function runBackgroundWatchSweep(
  enqueueResume: EnqueueResume,
  check: WatchRunner = runWatch,
): Promise<{ checked: number; settled: number }> {
  const s = getBackgroundTaskStore();
  const pending = await s.listPending();
  let settled = 0;
  for (const task of pending) {
    let outcome: WatchOutcome;
    try {
      outcome = await check(task.watch);
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : err, taskId: task.id }, "watch threw");
      continue;
    }
    if (!outcome.settled) continue;
    await s.markSettled(task.id, "completed", outcome.result);
    try {
      await enqueueResume({
        ...task,
        status: "completed",
        result: outcome.result,
        settledAt: Date.now(),
      });
      settled++;
    } catch (err) {
      log.error(
        { err: err instanceof Error ? err.message : err, taskId: task.id },
        "resume enqueue failed",
      );
    }
  }
  if (pending.length > 0) log.info({ checked: pending.length, settled }, "background watch sweep");
  return { checked: pending.length, settled };
}

/** The prompt handed to the agent when a task settles — resumes the same thread. */
export function buildResumePrompt(task: BackgroundTask): string {
  return [
    `Background task "${task.summary}" (${task.kind}) has finished.`,
    `Result:`,
    "```",
    (task.result ?? "(no output)").slice(0, 4000),
    "```",
    `Continue where you left off: report the outcome to the user and take any follow-up actions. Do not just acknowledge — act on the result.`,
  ].join("\n");
}
