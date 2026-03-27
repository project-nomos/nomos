/**
 * Multi-agent team orchestration.
 *
 * A coordinator agent decomposes a complex task into subtasks,
 * spawns parallel worker agents via independent `runSession()` calls,
 * and synthesizes their results into a single response.
 */

import { randomUUID } from "node:crypto";
import { runSession, type McpServerConfig } from "../sdk/session.ts";

export interface TeamConfig {
  /** Maximum number of parallel worker agents (default: 3) */
  maxWorkers: number;
  /** Maximum turns each worker agent can take (default: 20) */
  workerMaxTurns: number;
  /** Model for the coordinator agent */
  coordinatorModel?: string;
  /** Model for worker agents (defaults to coordinator model) */
  workerModel?: string;
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
    const workerPrompt = `You are a worker agent assigned a specific subtask. Focus ONLY on this subtask and produce a clear, complete result.

Subtask: ${subtask.description}

Execute this subtask thoroughly and provide your output.`;

    emit?.({
      type: "team",
      message: `Worker started: ${subtask.description.slice(0, 80)}...`,
    });

    const output = await this.runSingleAgent(workerPrompt, {
      model: this.config.workerModel ?? this.config.coordinatorModel,
      systemPromptAppend: task.systemPromptAppend,
      mcpServers: task.mcpServers,
      permissionMode: task.permissionMode,
      allowedTools: task.allowedTools,
      maxTurns: this.config.workerMaxTurns,
    });

    emit?.({
      type: "team",
      message: `Worker completed: ${subtask.description.slice(0, 80)}...`,
    });

    return output;
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
    },
  ): Promise<string> {
    console.log(`[team-runtime] Running agent (model: ${options.model ?? "default"})...`);

    const sdkQuery = runSession({
      prompt,
      model: options.model,
      systemPromptAppend: options.systemPromptAppend,
      mcpServers: options.mcpServers,
      permissionMode: options.permissionMode ?? "bypassPermissions",
      allowedTools: options.allowedTools,
      maxTurns: options.maxTurns ?? 20,
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
