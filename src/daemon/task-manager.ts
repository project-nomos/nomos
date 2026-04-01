/**
 * Task state machine for daemon background operations.
 *
 * Tracks running agent tasks with lifecycle states:
 * pending → running → completed | failed | killed
 *
 * Each task has an AbortController for cancellation support.
 */

import { randomUUID } from "node:crypto";

export type TaskStatus = "pending" | "running" | "completed" | "failed" | "killed";

export interface DaemonTask {
  id: string;
  name: string;
  description: string;
  status: TaskStatus;
  /** Source: cron job, team worker, user request, etc. */
  source: string;
  /** Session key associated with this task */
  sessionKey?: string;
  /** Abort controller for cancellation */
  abortController: AbortController;
  /** When the task was created */
  createdAt: Date;
  /** When the task started running */
  startedAt?: Date;
  /** When the task finished (completed/failed/killed) */
  finishedAt?: Date;
  /** Error message if failed */
  error?: string;
  /** Partial output collected so far */
  output?: string;
}

export interface TaskSummary {
  id: string;
  name: string;
  description: string;
  status: TaskStatus;
  source: string;
  sessionKey?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  error?: string;
}

/** Maximum number of completed tasks to retain in history. */
const MAX_HISTORY = 50;

export class TaskManager {
  private tasks = new Map<string, DaemonTask>();
  private completedHistory: TaskSummary[] = [];

  /** Create a new task in pending state. Returns the task ID. */
  create(opts: {
    name: string;
    description: string;
    source: string;
    sessionKey?: string;
  }): DaemonTask {
    const task: DaemonTask = {
      id: randomUUID(),
      name: opts.name,
      description: opts.description,
      status: "pending",
      source: opts.source,
      sessionKey: opts.sessionKey,
      abortController: new AbortController(),
      createdAt: new Date(),
    };
    this.tasks.set(task.id, task);
    return task;
  }

  /** Transition task to running state. */
  start(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    task.status = "running";
    task.startedAt = new Date();
  }

  /** Mark task as completed. */
  complete(taskId: string, output?: string): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    task.status = "completed";
    task.finishedAt = new Date();
    task.output = output;
    this.archiveTask(task);
  }

  /** Mark task as failed. */
  fail(taskId: string, error: string): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    task.status = "failed";
    task.finishedAt = new Date();
    task.error = error;
    this.archiveTask(task);
  }

  /** Kill a running task via abort signal. */
  kill(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    if (task.status !== "running" && task.status !== "pending") return false;

    task.abortController.abort();
    task.status = "killed";
    task.finishedAt = new Date();
    this.archiveTask(task);
    return true;
  }

  /** Get a task by ID (searches active + history). */
  get(taskId: string): TaskSummary | undefined {
    const active = this.tasks.get(taskId);
    if (active) return this.toSummary(active);
    return this.completedHistory.find((t) => t.id === taskId);
  }

  /** Get a task by ID prefix (short ID). */
  getByPrefix(prefix: string): TaskSummary | undefined {
    for (const [id, task] of this.tasks) {
      if (id.startsWith(prefix)) return this.toSummary(task);
    }
    return this.completedHistory.find((t) => t.id.startsWith(prefix));
  }

  /** List all active tasks (pending + running). */
  listActive(): TaskSummary[] {
    return [...this.tasks.values()]
      .filter((t) => t.status === "pending" || t.status === "running")
      .map((t) => this.toSummary(t));
  }

  /** List all tasks (active + recent history). */
  listAll(): TaskSummary[] {
    const active = [...this.tasks.values()].map((t) => this.toSummary(t));
    return [...active, ...this.completedHistory];
  }

  /** Get the abort signal for a task. */
  getAbortSignal(taskId: string): AbortSignal | undefined {
    return this.tasks.get(taskId)?.abortController.signal;
  }

  /** Append output to a running task. */
  appendOutput(taskId: string, text: string): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    task.output = (task.output ?? "") + text;
  }

  private toSummary(task: DaemonTask): TaskSummary {
    const summary: TaskSummary = {
      id: task.id,
      name: task.name,
      description: task.description,
      status: task.status,
      source: task.source,
      sessionKey: task.sessionKey,
      createdAt: task.createdAt.toISOString(),
    };
    if (task.startedAt) {
      summary.startedAt = task.startedAt.toISOString();
      const end = task.finishedAt ?? new Date();
      summary.durationMs = end.getTime() - task.startedAt.getTime();
    }
    if (task.finishedAt) summary.finishedAt = task.finishedAt.toISOString();
    if (task.error) summary.error = task.error;
    return summary;
  }

  private archiveTask(task: DaemonTask): void {
    this.completedHistory.unshift(this.toSummary(task));
    if (this.completedHistory.length > MAX_HISTORY) {
      this.completedHistory.pop();
    }
    this.tasks.delete(task.id);
  }
}

/** Singleton task manager for the daemon. */
let globalTaskManager: TaskManager | null = null;

export function getTaskManager(): TaskManager {
  if (!globalTaskManager) {
    globalTaskManager = new TaskManager();
  }
  return globalTaskManager;
}
