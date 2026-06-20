/**
 * Disk-backed background task store (POWER-USER default).
 *
 * Power-user has no Redis, but the daemon restarts on upgrade (launchctl
 * kickstart), which would drop in-flight background tasks held only in memory.
 * This store keeps tasks in memory for speed and write-throughs the PENDING set
 * to a small JSON file (`~/.nomos/background-tasks.json`, same pattern as the
 * auto-dream / magic-docs state files), so a CI/deploy task survives a restart.
 * Settled tasks are not persisted (they're done), keeping the file bounded.
 *
 * Single-process by construction (power-user), and per-session turns are
 * serialized by the MessageQueue, so synchronous read-modify-write is safe.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createLogger } from "../lib/logger.ts";
import type { BackgroundTask, BackgroundTaskStore, RegisterInput } from "./background-tasks.ts";

const log = createLogger("background-tasks-disk");

function defaultFile(): string {
  return join(homedir(), ".nomos", "background-tasks.json");
}

export class DiskBackgroundTaskStore implements BackgroundTaskStore {
  private tasks = new Map<string, BackgroundTask>();
  private loaded = false;

  constructor(private readonly file: string = defaultFile()) {}

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const arr = JSON.parse(readFileSync(this.file, "utf8")) as BackgroundTask[];
      for (const t of arr) if (t?.id) this.tasks.set(t.id, t);
      log.info({ file: this.file, pending: this.tasks.size }, "loaded persisted background tasks");
    } catch {
      /* no file yet — first run */
    }
  }

  /** Persist only pending tasks (settled ones are done) so the file stays small. */
  private save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const pending = [...this.tasks.values()].filter((t) => t.status === "pending");
      writeFileSync(this.file, JSON.stringify(pending), "utf8");
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : err },
        "failed to persist background tasks",
      );
    }
  }

  async register(input: RegisterInput): Promise<BackgroundTask> {
    this.load();
    const task: BackgroundTask = {
      id: randomUUID(),
      status: "pending",
      createdAt: Date.now(),
      ...input,
    };
    this.tasks.set(task.id, task);
    this.save();
    return task;
  }

  async listPending(): Promise<BackgroundTask[]> {
    this.load();
    return [...this.tasks.values()].filter((t) => t.status === "pending");
  }

  async get(id: string): Promise<BackgroundTask | undefined> {
    this.load();
    return this.tasks.get(id);
  }

  async markSettled(id: string, status: "completed" | "failed", result: string): Promise<void> {
    this.load();
    const t = this.tasks.get(id);
    if (!t) return;
    t.status = status;
    t.result = result;
    t.settledAt = Date.now();
    this.save(); // settled => dropped from the persisted (pending-only) file
  }

  async pendingForSession(sessionKey: string): Promise<BackgroundTask[]> {
    this.load();
    return [...this.tasks.values()].filter(
      (t) => t.status === "pending" && t.sessionKey === sessionKey,
    );
  }
}
