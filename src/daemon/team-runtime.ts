/**
 * Multi-agent team orchestration.
 *
 * A coordinator agent decomposes a complex task into subtasks,
 * spawns parallel worker agents via independent `runSession()` calls,
 * and synthesizes their results into a single response.
 *
 * Supports:
 * - Git worktree isolation: each worker gets its own branch
 * - Inter-agent messaging via team mailbox
 * - Task lifecycle tracking via TaskManager
 */

import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runSession, type McpServerConfig } from "../sdk/session.ts";
import { getTeamMailbox } from "./team-mailbox.ts";
import { getTaskManager } from "./task-manager.ts";

const execFileAsync = promisify(execFile);

export interface TeamConfig {
  /** Maximum number of parallel worker agents (default: 3) */
  maxWorkers: number;
  /** Maximum turns each worker agent can take (default: 20) */
  workerMaxTurns: number;
  /** Model for the coordinator agent */
  coordinatorModel?: string;
  /** Model for worker agents (defaults to coordinator model) */
  workerModel?: string;
  /** Enable git worktree isolation for workers (each gets its own branch) */
  worktreeIsolation?: boolean;
}

export interface TeamTask {
  /** The full task description from the user */
  prompt: string;
  /** System prompt append for all agents */
  systemPromptAppend?: string;
  /** MCP servers available to workers */
  mcpServers?: Record<string, McpServerConfig>;
  /** Permission mode */
  permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk";
  /** Allowed tools (auto-approved without prompting) */
  allowedTools?: string[];
}

interface Subtask {
  id: string;
  description: string;
}

interface WorkerResult {
  subtaskId: string;
  description: string;
  status: "fulfilled" | "rejected";
  output: string;
}

const DECOMPOSITION_PROMPT = `You are a task coordinator. Analyze the following task and break it down into independent subtasks that can be executed in parallel by separate agents.

IMPORTANT RULES:
- Each subtask must be self-contained and independently executable
- Output ONLY a JSON array of subtask descriptions, nothing else
- Keep subtasks focused — each should produce a clear, distinct deliverable
- Maximum {maxWorkers} subtasks
- If the task is simple enough for a single agent, output a single-element array

Task:
{task}

Respond with ONLY a JSON array of strings, e.g.:
["Research X and summarize findings", "Implement Y with tests", "Write documentation for Z"]`;

const SYNTHESIS_PROMPT = `You are synthesizing results from multiple worker agents that executed subtasks in parallel. Combine their outputs into a single coherent response for the user.

Original task: {task}

Worker results:
{results}

Provide a unified, well-structured response that integrates all worker outputs. If any worker failed, note what couldn't be completed.`;

export class TeamRuntime {
  private config: TeamConfig;

  constructor(config: Partial<TeamConfig> = {}) {
    this.config = {
      maxWorkers: config.maxWorkers ?? 4,
      workerMaxTurns: config.workerMaxTurns ?? 20,
      coordinatorModel: config.coordinatorModel,
      workerModel: config.workerModel,
      worktreeIsolation: config.worktreeIsolation ?? false,
    };
  }

  /**
   * Run a task using multi-agent team coordination.
   *
   * 1. Coordinator decomposes the task into subtasks
   * 2. Worker agents execute subtasks in parallel
   * 3. Coordinator synthesizes results
   */
  async runTeam(
    task: TeamTask,
    emit?: (event: { type: string; message: string }) => void,
  ): Promise<string> {
    emit?.({ type: "team", message: "Decomposing task into subtasks..." });

    // Step 1: Decompose
    const subtasks = await this.decompose(task);

    if (subtasks.length === 0) {
      return "Could not decompose the task into subtasks.";
    }

    emit?.({
      type: "team",
      message: `Spawning ${subtasks.length} worker agent(s)...`,
    });

    // Step 2: Execute workers in parallel
    const results = await this.executeWorkers(subtasks, task, emit);

    emit?.({ type: "team", message: "Synthesizing results..." });

    // Step 3: Synthesize
    const synthesized = await this.synthesize(task.prompt, results, task);

    return synthesized;
  }

  /** Decompose a task into subtasks via a coordinator query. */
  private async decompose(task: TeamTask): Promise<Subtask[]> {
    const prompt = DECOMPOSITION_PROMPT.replace("{task}", task.prompt).replace(
      "{maxWorkers}",
      String(this.config.maxWorkers),
    );

    const output = await this.runSingleAgent(prompt, {
      model: this.config.coordinatorModel,
      systemPromptAppend: task.systemPromptAppend,
      mcpServers: task.mcpServers,
      permissionMode: task.permissionMode,
      maxTurns: 5,
    });

    // Extract JSON array from the output
    const match = output.match(/\[[\s\S]*\]/);
    if (!match) {
      // Fallback: treat entire task as single subtask
      return [{ id: randomUUID(), description: task.prompt }];
    }

    try {
      const descriptions: string[] = JSON.parse(match[0]);
      return descriptions
        .slice(0, this.config.maxWorkers)
        .map((desc) => ({ id: randomUUID(), description: desc }));
    } catch {
      return [{ id: randomUUID(), description: task.prompt }];
    }
  }

  /** Execute subtasks via parallel worker agents. */
  private async executeWorkers(
    subtasks: Subtask[],
    task: TeamTask,
    emit?: (event: { type: string; message: string }) => void,
  ): Promise<WorkerResult[]> {
    const workerPromises = subtasks.map((subtask) => this.spawnWorker(subtask, task, emit));

    const settled = await Promise.allSettled(workerPromises);

    return settled.map((result, i) => {
      const subtask = subtasks[i]!;
      if (result.status === "fulfilled") {
        return {
          subtaskId: subtask.id,
          description: subtask.description,
          status: "fulfilled" as const,
          output: result.value,
        };
      }
      return {
        subtaskId: subtask.id,
        description: subtask.description,
        status: "rejected" as const,
        output: result.reason instanceof Error ? result.reason.message : String(result.reason),
      };
    });
  }

  /** Spawn a single worker agent for a subtask. */
  private async spawnWorker(
    subtask: Subtask,
    task: TeamTask,
    emit?: (event: { type: string; message: string }) => void,
  ): Promise<string> {
    const workerId = `worker-${subtask.id.slice(0, 8)}`;
    const mailbox = getTeamMailbox();
    const tm = getTaskManager();

    // Register task in TaskManager
    const daemonTask = tm.create({
      name: `team:${workerId}`,
      description: subtask.description.slice(0, 200),
      source: "team-worker",
    });
    tm.start(daemonTask.id);

    const workerPrompt = `You are worker agent "${workerId}" assigned a specific subtask within a team. Focus ONLY on this subtask and produce a clear, complete result.

Subtask: ${subtask.description}

You have access to these inter-agent communication tools:
- send_worker_message: Send messages to "coordinator" or other workers
- check_worker_messages: Check for messages from the coordinator or other workers

If you encounter a blocking issue, send a message to "coordinator" with priority "blocking".
Execute this subtask thoroughly and provide your output.`;

    emit?.({
      type: "team",
      message: `Worker ${workerId} started: ${subtask.description.slice(0, 80)}...`,
    });

    let worktreePath: string | undefined;
    let worktreeBranch: string | undefined;

    try {
      // Set up git worktree isolation if enabled
      if (this.config.worktreeIsolation) {
        try {
          worktreeBranch = `team/${workerId}-${Date.now()}`;
          worktreePath = `.claude/worktrees/${workerId}`;
          await execFileAsync("git", ["worktree", "add", "-b", worktreeBranch, worktreePath]);
          emit?.({
            type: "team",
            message: `Worker ${workerId} isolated in worktree: ${worktreeBranch}`,
          });
        } catch {
          // Git worktree not available or not a git repo — continue without isolation
          worktreePath = undefined;
          worktreeBranch = undefined;
        }
      }

      const output = await this.runSingleAgent(workerPrompt, {
        model: this.config.workerModel ?? this.config.coordinatorModel,
        systemPromptAppend: task.systemPromptAppend,
        mcpServers: task.mcpServers,
        permissionMode: task.permissionMode,
        allowedTools: task.allowedTools,
        maxTurns: this.config.workerMaxTurns,
        cwd: worktreePath,
      });

      tm.complete(daemonTask.id, output.slice(0, 500));

      // Notify coordinator via mailbox
      mailbox.sendFrom(
        workerId,
        "coordinator",
        `Subtask completed: ${subtask.description.slice(0, 100)}`,
      );

      emit?.({
        type: "team",
        message: `Worker ${workerId} completed${worktreeBranch ? ` (branch: ${worktreeBranch})` : ""}`,
      });

      // Include worktree info in output if changes were made
      const finalOutput = worktreeBranch
        ? `${output}\n\n[Changes on branch: ${worktreeBranch}]`
        : output;

      return finalOutput;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      tm.fail(daemonTask.id, errMsg);
      mailbox.sendFrom(workerId, "coordinator", `Subtask FAILED: ${errMsg}`, "urgent");
      throw err;
    } finally {
      // Clean up worktree if no changes were made
      if (worktreePath) {
        try {
          const { stdout } = await execFileAsync("git", [
            "-C",
            worktreePath,
            "status",
            "--porcelain",
          ]);
          if (!stdout.trim()) {
            // No changes — remove worktree
            await execFileAsync("git", ["worktree", "remove", worktreePath, "--force"]);
            if (worktreeBranch) {
              await execFileAsync("git", ["branch", "-D", worktreeBranch]).catch(() => {});
            }
          }
        } catch {
          // Worktree cleanup failed — leave for manual cleanup
        }
      }
    }
  }

  /** Synthesize worker results into a final response. */
  private async synthesize(
    originalTask: string,
    results: WorkerResult[],
    task: TeamTask,
  ): Promise<string> {
    const resultsText = results
      .map((r, i) => {
        const status = r.status === "fulfilled" ? "COMPLETED" : "FAILED";
        return `--- Worker ${i + 1} [${status}] ---\nSubtask: ${r.description}\nOutput:\n${r.output}`;
      })
      .join("\n\n");

    const prompt = SYNTHESIS_PROMPT.replace("{task}", originalTask).replace(
      "{results}",
      resultsText,
    );

    return this.runSingleAgent(prompt, {
      model: this.config.coordinatorModel,
      systemPromptAppend: task.systemPromptAppend,
      mcpServers: task.mcpServers,
      permissionMode: task.permissionMode,
      maxTurns: 10,
    });
  }

  /** Run a single agent call and collect the text output. */
  private async runSingleAgent(
    prompt: string,
    options: {
      model?: string;
      systemPromptAppend?: string;
      mcpServers?: Record<string, McpServerConfig>;
      permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk";
      allowedTools?: string[];
      maxTurns?: number;
      cwd?: string;
    },
  ): Promise<string> {
    console.log(
      `[team-runtime] Running agent (model: ${options.model ?? "default"}${options.cwd ? `, cwd: ${options.cwd}` : ""})...`,
    );

    const sdkQuery = runSession({
      prompt,
      model: options.model,
      systemPromptAppend: options.systemPromptAppend,
      mcpServers: options.mcpServers,
      permissionMode: options.permissionMode ?? "bypassPermissions",
      allowedTools: options.allowedTools,
      maxTurns: options.maxTurns ?? 20,
      ...(options.cwd ? { cwd: options.cwd } : {}),
    });

    let fullText = "";

    for await (const msg of sdkQuery) {
      console.log(`[team-runtime] Event: ${msg.type}`);
      if (msg.type === "assistant") {
        for (const block of msg.message.content) {
          if (block.type === "text" && block.text) {
            if (fullText && !fullText.endsWith("\n")) fullText += "\n";
            fullText += block.text;
          }
        }
      } else if (msg.type === "result") {
        for (const block of msg.result) {
          if (block.type === "text") {
            fullText += block.text;
          }
        }
      }
    }

    console.log(`[team-runtime] Agent finished (${fullText.length} chars)`);
    return fullText;
  }
}

/** Strip `/team` prefix from a message if present. */
export function stripTeamPrefix(content: string): string | null {
  const match = content.match(/^\/team\s+([\s\S]+)/i);
  return match ? match[1]!.trim() : null;
}
