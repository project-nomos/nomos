/**
 * Task state machine for daemon background operations.
 *
 * Tracks running agent tasks with lifecycle states:
 * pending → running → completed | failed | killed
 *
 * Supports dependency graph: tasks can declare `blocks` and `blockedBy`
 * relationships. A task won't start until all its blockers are completed.
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
  /** Optional owner (worker ID, agent name) */
  owner?: string;
  /** Task IDs that this task blocks (downstream dependents) */
  blocks: string[];
  /** Task IDs that must complete before this task can start */
  blockedBy: string[];
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
  owner?: string;
  blocks: string[];
  blockedBy: string[];
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

  /** Create a new task in pending state. Returns the task. */
  create(opts: {
    name: string;
    description: string;
    source: string;
    sessionKey?: string;
    owner?: string;
    blockedBy?: string[];
  }): DaemonTask {
    const task: DaemonTask = {
      id: randomUUID(),
      name: opts.name,
      description: opts.description,
      status: "pending",
      source: opts.source,
      sessionKey: opts.sessionKey,
      owner: opts.owner,
      blocks: [],
      blockedBy: opts.blockedBy ?? [],
      abortController: new AbortController(),
      createdAt: new Date(),
    };
    this.tasks.set(task.id, task);

    // Register reverse dependency: tell blockers they block this task
    for (const blockerId of task.blockedBy) {
      const blocker = this.tasks.get(blockerId);
      if (blocker && !blocker.blocks.includes(task.id)) {
        blocker.blocks.push(task.id);
      }
    }

    return task;
  }

  /** Add a dependency: `taskId` is blocked by `blockerId`. */
  addDependency(taskId: string, blockerId: string): boolean {
    const task = this.tasks.get(taskId);
    const blocker = this.tasks.get(blockerId);
    if (!task || !blocker) return false;
    if (taskId === blockerId) return false;

    // Prevent circular dependencies
    if (this.wouldCreateCycle(blockerId, taskId)) return false;

    if (!task.blockedBy.includes(blockerId)) {
      task.blockedBy.push(blockerId);
    }
    if (!blocker.blocks.includes(taskId)) {
      blocker.blocks.push(taskId);
    }
    return true;
  }

  /** Check if adding blockerId → taskId would create a cycle. */
  private wouldCreateCycle(fromId: string, toId: string): boolean {
    const visited = new Set<string>();
    const queue = [toId];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current === fromId) return true;
      if (visited.has(current)) continue;
      visited.add(current);
      const task = this.tasks.get(current);
      if (task) {
        queue.push(...task.blocks);
      }
    }
    return false;
  }

  /** Check if a task's dependencies are all satisfied (completed). */
  isReady(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    if (task.blockedBy.length === 0) return true;

    return task.blockedBy.every((blockerId) => {
      const blocker = this.tasks.get(blockerId);
      if (!blocker) {
        // Check history — if archived as completed, it's satisfied
        const archived = this.completedHistory.find((t) => t.id === blockerId);
        return archived?.status === "completed";
      }
      return blocker.status === "completed";
    });
  }

  /** Get tasks that are pending and ready to run (all dependencies met). */
  getReadyTasks(): DaemonTask[] {
    return [...this.tasks.values()].filter((t) => t.status === "pending" && this.isReady(t.id));
  }

  /** Transition task to running state. Returns false if blocked by dependencies. */
  start(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    if (!this.isReady(taskId)) return false;
    task.status = "running";
    task.startedAt = new Date();
    return true;
  }

  /** Mark task as completed. Emits ready:task events for unblocked dependents. */
  complete(taskId: string, output?: string): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    task.status = "completed";
    task.finishedAt = new Date();
    task.output = output;

    // Notify downstream tasks that a blocker is done
    const unblockedIds = [...task.blocks];
    this.archiveTask(task);

    // Emit events for tasks that are now ready
    for (const dependentId of unblockedIds) {
      if (this.isReady(dependentId)) {
        try {
          process.emit("task:ready" as never, dependentId as never);
        } catch {
          // Not critical
        }
      }
    }
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
      owner: task.owner,
      blocks: [...task.blocks],
      blockedBy: [...task.blockedBy],
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
