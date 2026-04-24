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
 * - Verification agent: adversarial testing after workers complete
 *
 * Coordinator prompt adapted from Claude Code's coordinator mode.
 * Verification prompt adapted from Claude Code's verification agent.
 */

import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runSession, type McpServerConfig, type SdkPluginConfig } from "../sdk/session.ts";
import { getTeamMailbox } from "./team-mailbox.ts";
import { getTaskManager } from "./task-manager.ts";

const execFileAsync = promisify(execFile);

export interface TeamConfig {
  /** Maximum number of parallel worker agents (default: 3) */
  maxWorkers: number;
  /** Maximum turns each worker agent can take (default: 20) */
  workerMaxTurns: number;
  /** Budget cap per worker in USD (default: 2) */
  workerBudgetUsd: number;
  /** Per-worker timeout in ms (default: 5 minutes) */
  workerTimeoutMs: number;
  /** Model for the coordinator agent */
  coordinatorModel?: string;
  /** Model for worker agents (defaults to coordinator model) */
  workerModel?: string;
  /** Enable git worktree isolation for workers (each gets its own branch) */
  worktreeIsolation?: boolean;
  /** Enable verification agent after workers complete (adversarial testing) */
  verification?: boolean;
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
  /** Override model for this team run (e.g. from smart routing) */
  model?: string;
  /** Plugins to load into worker SDK sessions */
  plugins?: SdkPluginConfig[];
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

// ── Coordinator Prompt ──
// Adapted from Claude Code's coordinator mode (coordinatorMode.ts)

const DECOMPOSITION_PROMPT = `You are a coordinator orchestrating tasks across multiple workers.

## Your Role

You are a **coordinator**. Your job is to:
- Analyze the task and break it into independent subtasks
- Each subtask must be self-contained — workers can't see your conversation
- Keep subtasks focused with clear, distinct deliverables
- Maximum {maxWorkers} subtasks
- If the task is simple enough for a single agent, output a single-element array

## CRITICAL: All Workers Run in Parallel

**All workers start at the same time and run simultaneously.** This means:
- **NO task can depend on another task's output** — a worker cannot read files created by another worker
- **NO task can reference "findings from task 1"** or "based on research" — each worker is completely independent
- **Each worker must do its own research** — if multiple tasks need the same context, include the relevant info in each task's prompt
- **Do NOT create a "synthesis" or "combine results" task** — that happens automatically after all workers finish

## Concurrency Rules

- **Read-only tasks** (research) — run in parallel freely
- **Write-heavy tasks** — each worker must write to DIFFERENT files (no overlapping paths)
- **Verification** — handled automatically after workers complete; do not create a verification subtask

## Writing Worker Prompts

**Workers can't see your conversation or each other.** Every subtask must be self-contained with everything the worker needs.

- Include specific file paths, directories to explore, URLs to research
- State what "done" looks like (e.g., "create a file at marketing/brand-guidelines.md")
- Add a purpose statement so workers calibrate depth
- If workers write files, specify unique file paths for each worker to avoid conflicts

Task:
{task}

**Do NOT use any tools.** Do NOT read files, browse the web, or run commands. Your ONLY job is to output the JSON array below.

Respond with ONLY a JSON array of strings. Each string must be a complete, self-contained instruction. No other text before or after the array:
["Research the codebase at /path/to/project — explore the directory structure, read key files, and create a comprehensive analysis at marketing/01-research.md", "Research competitor landscape for X and create a strategy document at marketing/02-strategy.md", "Create brand guidelines based on your own research of the project at marketing/03-brand.md"]`;

const SYNTHESIS_PROMPT = `You are synthesizing results from multiple worker agents that executed subtasks in parallel. Combine their outputs into a single coherent response for the user.

## Synthesis Rules

- **Read all findings** — understand what each worker discovered before writing
- **Never write "based on the worker's findings"** — synthesize, don't delegate
- **Include specific details** — file paths, line numbers, code snippets from worker outputs
- **Note failures explicitly** — if any worker failed, explain what couldn't be completed and why

Original task: {task}

Worker results:
{results}

Provide a unified, well-structured response that integrates all worker outputs.`;

// ── Verification Agent Prompt ──
// Adapted from Claude Code's verification agent (verificationAgent.ts)

const VERIFICATION_PROMPT = `You are a verification specialist. Your job is not to confirm the implementation works — it's to try to break it.

You have two documented failure patterns. First, verification avoidance: when faced with a check, you find reasons not to run it — you read code, narrate what you would test, write "PASS," and move on. Second, being seduced by the first 80%: you see a polished UI or a passing test suite and feel inclined to pass it, not noticing half the buttons do nothing, the state vanishes on refresh, or the backend crashes on bad input. The first 80% is the easy part. Your entire value is in finding the last 20%.

=== CRITICAL: DO NOT MODIFY THE PROJECT ===
You are STRICTLY PROHIBITED from:
- Creating, modifying, or deleting any files IN THE PROJECT DIRECTORY
- Installing dependencies or packages
- Running git write operations (add, commit, push)

You MAY write ephemeral test scripts to a temp directory (/tmp or $TMPDIR) when inline commands aren't sufficient. Clean up after yourself.

=== VERIFICATION STRATEGY ===
Adapt your strategy based on what was changed:

**Content/writing tasks** (docs, marketing, plans, analysis): Read every file the workers produced. Verify: files exist and are non-empty, content matches the original task requirements, claims are specific (not generic filler), numbers/budgets/timelines are internally consistent across documents, no placeholder text remains. Cross-reference factual claims against source code if a codebase was referenced.
**Frontend changes**: Start dev server → navigate and test in browser → curl page subresources → run frontend tests
**Backend/API changes**: Start server → curl/fetch endpoints → verify response shapes → test error handling → check edge cases
**CLI/script changes**: Run with representative inputs → verify stdout/stderr/exit codes → test edge inputs
**Infrastructure/config changes**: Validate syntax → dry-run where possible → check env vars are referenced
**Library/package changes**: Build → full test suite → exercise the public API as a consumer would
**Bug fixes**: Reproduce the original bug → verify fix → run regression tests → check related functionality
**Database migrations**: Run migration up → verify schema → run down (reversibility) → test against existing data
**Refactoring (no behavior change)**: Existing test suite MUST pass unchanged → diff the public API surface

=== REQUIRED STEPS ===
1. Read the project's CLAUDE.md / README for build/test commands and conventions.
2. Run the build (if applicable). A broken build is an automatic FAIL.
3. Run the project's test suite (if it has one). Failing tests are an automatic FAIL.
4. Run linters/type-checkers if configured.
5. Check for regressions in related code.

Then apply the type-specific strategy above.

Test suite results are context, not evidence. Run the suite, note pass/fail, then move on to your real verification. The implementer is an LLM too — its tests may be heavy on mocks, circular assertions, or happy-path coverage.

=== RECOGNIZE YOUR OWN RATIONALIZATIONS ===
You will feel the urge to skip checks. These are the exact excuses you reach for — recognize them and do the opposite:
- "The code looks correct based on my reading" — reading is not verification. Run it.
- "The implementer's tests already pass" — the implementer is an LLM. Verify independently.
- "This is probably fine" — probably is not verified. Run it.
- "This would take too long" — not your call.
If you catch yourself writing an explanation instead of a command, stop. Run the command.

=== ADVERSARIAL PROBES ===
Functional tests confirm the happy path. Also try to break it:
- **Concurrency**: parallel requests to create-if-not-exists paths — duplicate sessions? lost writes?
- **Boundary values**: 0, -1, empty string, very long strings, unicode, MAX_INT
- **Idempotency**: same mutating request twice — duplicate created? error? correct no-op?
- **Orphan operations**: delete/reference IDs that don't exist

=== BEFORE ISSUING PASS ===
Your report must include at least one adversarial probe you ran and its result. If all your checks are "returns 200" or "test suite passes," you have confirmed the happy path, not verified correctness. Go back and try to break something.

=== BEFORE ISSUING FAIL ===
Check you haven't missed why it's actually fine:
- **Already handled**: is there defensive code elsewhere?
- **Intentional**: does CLAUDE.md / comments explain this as deliberate?
- **Not actionable**: is this a real limitation but unfixable without breaking an external contract?

=== OUTPUT FORMAT (REQUIRED) ===
Every check MUST follow this structure:

### Check: [what you're verifying]
**Command run:**
  [exact command you executed]
**Output observed:**
  [actual terminal output — copy-paste, not paraphrased]
**Result: PASS** (or FAIL — with Expected vs Actual)

End with exactly one of:
VERDICT: PASS
VERDICT: FAIL
VERDICT: PARTIAL

PARTIAL is for environmental limitations only — not for "I'm unsure whether this is a bug."`;

interface VerificationResult {
  verdict: "PASS" | "FAIL" | "PARTIAL";
  summary: string;
  checks: Array<{ name: string; result: string; detail?: string }>;
}

export class TeamRuntime {
  private config: TeamConfig;

  constructor(config: Partial<TeamConfig> = {}) {
    this.config = {
      maxWorkers: config.maxWorkers ?? 3,
      workerMaxTurns: config.workerMaxTurns ?? 20,
      workerBudgetUsd: config.workerBudgetUsd ?? 2,
      workerTimeoutMs: config.workerTimeoutMs ?? 15 * 60 * 1000,
      coordinatorModel: config.coordinatorModel,
      workerModel: config.workerModel,
      worktreeIsolation: config.worktreeIsolation ?? false,
      verification: config.verification ?? true,
    };
  }

  /**
   * Run a task using multi-agent team coordination.
   *
   * 1. Coordinator decomposes the task into subtasks
   * 2. Worker agents execute subtasks in parallel
   * 3. Verification agent checks the results (if enabled)
   * 4. Coordinator synthesizes results
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

    const teamStartTime = Date.now();
    const timeoutMin = Math.round(this.config.workerTimeoutMs / 60_000);
    emit?.({
      type: "team",
      message: `Spawning ${subtasks.length} agent(s) (${timeoutMin}min timeout each)...`,
    });

    // Step 2: Execute workers in parallel
    const results = await this.executeWorkers(subtasks, task, emit);

    // Step 3: Verification (if enabled and workers produced changes)
    let verification: VerificationResult | undefined;
    if (this.config.verification) {
      const hasSuccessful = results.some((r) => r.status === "fulfilled");
      if (hasSuccessful) {
        emit?.({ type: "team", message: "Running verification agent..." });
        verification = await this.verify(task, results);
        const verdictLabel =
          verification.verdict === "PASS"
            ? "passed"
            : verification.verdict === "FAIL"
              ? "found issues"
              : "partially verified";
        emit?.({
          type: "team",
          message: `Verification ${verdictLabel}`,
        });
      }
    }

    const workersElapsed = Math.round((Date.now() - teamStartTime) / 1000);
    emit?.({
      type: "team",
      message: `Agents finished in ${workersElapsed}s. Synthesizing results...`,
    });

    // Step 4: Synthesize
    const synthesized = await this.synthesize(task.prompt, results, task, verification?.summary);

    // Append verification notes if there were findings
    if (verification && verification.verdict !== "PASS" && verification.checks.length > 0) {
      const verificationNote = [
        "",
        "---",
        `**Verification Notes**`,
        verification.summary,
        ...verification.checks.map(
          (c) => `- ${c.result} ${c.name}${c.detail ? `: ${c.detail}` : ""}`,
        ),
      ].join("\n");
      return synthesized + verificationNote;
    }

    return synthesized;
  }

  /** Decompose a task into subtasks via a coordinator query. */
  private async decompose(task: TeamTask): Promise<Subtask[]> {
    const prompt = DECOMPOSITION_PROMPT.replace("{task}", task.prompt).replace(
      "{maxWorkers}",
      String(this.config.maxWorkers),
    );

    let output: string;
    try {
      output = await this.runSingleAgent(prompt, {
        model: task.model ?? this.config.coordinatorModel,
        permissionMode: task.permissionMode,
        maxTurns: 2,
        plugins: task.plugins,
      });
      console.log(
        `[team-runtime] Coordinator output (${output.length} chars): ${output.slice(0, 300)}`,
      );
    } catch (err) {
      console.error("[team-runtime] Coordinator decomposition failed:", err);
      // Fallback: treat entire task as single subtask
      return [{ id: randomUUID(), description: task.prompt }];
    }

    // Extract JSON array from the output.
    // The coordinator may wrap it in ```json ... ``` fences or add text after.
    const descriptions = this.extractJsonArray(output);
    if (!descriptions) {
      console.error(
        `[team-runtime] Coordinator did not return valid JSON array. Output (${output.length} chars): ${output.slice(0, 500)}`,
      );
      return [{ id: randomUUID(), description: task.prompt }];
    }

    console.log(`[team-runtime] Coordinator decomposed into ${descriptions.length} subtask(s)`);
    return descriptions
      .slice(0, this.config.maxWorkers)
      .map((desc) => ({ id: randomUUID(), description: desc }));
  }

  /** Robustly extract a JSON string array from coordinator output. */
  private extractJsonArray(output: string): string[] | null {
    // Strip markdown code fences
    let cleaned = output
      .replace(/```(?:json)?\s*/gi, "")
      .replace(/```/g, "")
      .trim();

    // Strategy 1: Try parsing the cleaned output directly (if it's just a JSON array)
    try {
      const parsed = JSON.parse(cleaned);
      if (Array.isArray(parsed) && parsed.every((s) => typeof s === "string")) {
        return parsed;
      }
    } catch {
      // Not pure JSON — try extraction
    }

    // Strategy 2: Find balanced brackets — scan for the first [ and find its matching ]
    const startIdx = cleaned.indexOf("[");
    if (startIdx === -1) return null;

    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = startIdx; i < cleaned.length; i++) {
      const ch = cleaned[i]!;
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\" && inString) {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (ch === "[") depth++;
      if (ch === "]") {
        depth--;
        if (depth === 0) {
          const candidate = cleaned.slice(startIdx, i + 1);
          try {
            const parsed = JSON.parse(candidate);
            if (Array.isArray(parsed) && parsed.every((s) => typeof s === "string")) {
              return parsed;
            }
          } catch (err) {
            console.error(
              `[team-runtime] Balanced bracket extraction failed: ${err instanceof Error ? err.message : err}`,
            );
          }
          break;
        }
      }
    }

    // Strategy 3: Greedy regex fallback
    const match = cleaned.match(/\[[\s\S]*\]/);
    if (match) {
      try {
        const parsed = JSON.parse(match[0]);
        if (Array.isArray(parsed) && parsed.every((s) => typeof s === "string")) {
          return parsed;
        }
      } catch {
        // Give up
      }
    }

    return null;
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
      message: `Agent ${workerId} started: ${subtask.description.slice(0, 80)}...`,
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
            message: `Agent ${workerId} isolated in worktree: ${worktreeBranch}`,
          });
        } catch {
          // Git worktree not available or not a git repo — continue without isolation
          worktreePath = undefined;
          worktreeBranch = undefined;
        }
      }

      // Forward worker events with worker ID prefix
      const workerEmit = emit
        ? (event: { type: string; message: string }) =>
            emit({ ...event, message: `[${workerId}] ${event.message}` })
        : undefined;

      const startTime = Date.now();
      const timeoutMs = this.config.workerTimeoutMs;
      const timeoutSec = Math.round(timeoutMs / 1000);

      let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
      let warningTimer: ReturnType<typeof setTimeout> | undefined;

      try {
        const agentPromise = this.runSingleAgent(
          workerPrompt,
          {
            model: task.model ?? this.config.workerModel ?? this.config.coordinatorModel,
            systemPromptAppend: task.systemPromptAppend,
            mcpServers: task.mcpServers,
            permissionMode: task.permissionMode,
            allowedTools: task.allowedTools,
            maxTurns: this.config.workerMaxTurns,
            maxBudgetUsd: this.config.workerBudgetUsd,
            cwd: worktreePath,
            plugins: task.plugins,
          },
          workerEmit,
        );

        const output = await Promise.race([
          agentPromise,
          new Promise<never>((_, reject) => {
            // Emit a warning 60s before the timeout fires
            const warningDelay = timeoutMs - 60_000;
            if (warningDelay > 0) {
              warningTimer = setTimeout(() => {
                const remaining = Math.round((timeoutMs - (Date.now() - startTime)) / 1000);
                emit?.({
                  type: "team",
                  message: `Agent ${workerId} approaching timeout (${remaining}s remaining)`,
                });
              }, warningDelay);
            }
            timeoutTimer = setTimeout(
              () => reject(new Error(`Worker timed out after ${timeoutSec}s`)),
              timeoutMs,
            );
          }),
        ]);

        const elapsedSec = Math.round((Date.now() - startTime) / 1000);
        tm.complete(daemonTask.id, output.slice(0, 500));

        // Notify coordinator via mailbox
        mailbox.sendFrom(
          workerId,
          "coordinator",
          `Subtask completed: ${subtask.description.slice(0, 100)}`,
        );

        emit?.({
          type: "team",
          message: `Agent ${workerId} completed in ${elapsedSec}s${worktreeBranch ? ` (branch: ${worktreeBranch})` : ""}`,
        });

        // Include worktree info in output if changes were made
        return worktreeBranch ? `${output}\n\n[Changes on branch: ${worktreeBranch}]` : output;
      } finally {
        if (warningTimer) clearTimeout(warningTimer);
        if (timeoutTimer) clearTimeout(timeoutTimer);
      }
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

  /** Run adversarial verification on worker results. */
  private async verify(task: TeamTask, results: WorkerResult[]): Promise<VerificationResult> {
    const resultsText = results
      .filter((r) => r.status === "fulfilled")
      .map((r) => `Worker: ${r.description}\nOutput: ${r.output.slice(0, 2000)}`)
      .join("\n\n");

    const verifyPrompt = `${VERIFICATION_PROMPT}

=== WHAT YOU RECEIVED ===
Original task: ${task.prompt}

Worker results:
${resultsText}

Verify the workers' changes are correct. Run builds, tests, linters, and adversarial probes. End with your VERDICT.`;

    try {
      const output = await this.runSingleAgent(verifyPrompt, {
        model: task.model ?? this.config.coordinatorModel,
        systemPromptAppend: task.systemPromptAppend,
        mcpServers: task.mcpServers,
        permissionMode: "bypassPermissions",
        maxTurns: 30,
        plugins: task.plugins,
      });

      console.log(
        `[team-runtime] Verification output (${output.length} chars): ${output.slice(0, 500)}`,
      );

      // Parse verdict — if verification didn't complete (no VERDICT line), treat as PASS
      // rather than penalizing with PARTIAL (the agent ran out of turns, not a real failure)
      const verdictMatch = output.match(/VERDICT:\s*(PASS|FAIL|PARTIAL)/i);
      const verdict = (verdictMatch?.[1]?.toUpperCase() ?? "PASS") as "PASS" | "FAIL" | "PARTIAL";

      // Extract check results (lines matching "PASS/FAIL/PARTIAL: description")
      const checks: Array<{ name: string; result: string; detail?: string }> = [];
      const checkPattern = /(?:^|\n)\s*\*?\*?\s*(PASS|FAIL|PARTIAL)\s*[-:]\s*(.+)/gi;
      let match;
      while ((match = checkPattern.exec(output)) !== null) {
        checks.push({
          name: match[2]!.trim().slice(0, 100),
          result: match[1]!.toUpperCase(),
        });
      }

      return {
        verdict,
        summary: output.slice(0, 500),
        checks,
      };
    } catch (err) {
      console.error("[team-runtime] Verification agent failed:", err);
      return {
        verdict: "PARTIAL",
        summary: "Verification agent failed to complete",
        checks: [
          {
            name: "Verification execution",
            result: "FAIL",
            detail: err instanceof Error ? err.message : String(err),
          },
        ],
      };
    }
  }

  /** Synthesize worker results into a final response. */
  private async synthesize(
    originalTask: string,
    results: WorkerResult[],
    task: TeamTask,
    verificationResult?: string,
  ): Promise<string> {
    const resultsText = results
      .map((r, i) => {
        const status = r.status === "fulfilled" ? "COMPLETED" : "FAILED";
        return `--- Agent ${i + 1} [${status}] ---\nSubtask: ${r.description}\nOutput:\n${r.output}`;
      })
      .join("\n\n");

    const verificationSection = verificationResult
      ? `\n\nVerification Agent Report:\n${verificationResult}`
      : "";

    const prompt = SYNTHESIS_PROMPT.replace("{task}", originalTask).replace(
      "{results}",
      resultsText + verificationSection,
    );

    // Synthesis only combines text — no tools needed
    try {
      return await this.runSingleAgent(prompt, {
        model: task.model ?? this.config.coordinatorModel,
        permissionMode: task.permissionMode,
        maxTurns: 10,
        plugins: task.plugins,
      });
    } catch (err) {
      console.error("[team-runtime] Synthesis agent failed, returning raw results:", err);
      // Fallback: return worker outputs directly
      return results
        .map((r, i) => {
          const status = r.status === "fulfilled" ? "Completed" : "Failed";
          return `## Agent ${i + 1} (${status})\n**Task:** ${r.description}\n\n${r.output}`;
        })
        .join("\n\n---\n\n");
    }
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
      maxBudgetUsd?: number;
      cwd?: string;
      plugins?: SdkPluginConfig[];
      useSubscription?: boolean;
    },
    emit?: (event: { type: string; message: string }) => void,
  ): Promise<string> {
    console.log(
      `[team-runtime] Running agent (model: ${options.model ?? "default"}${options.cwd ? `, cwd: ${options.cwd}` : ""})...`,
    );

    const stderrChunks: string[] = [];
    const stderrLogFile = path.join(os.homedir(), ".nomos", `team-stderr-${Date.now()}.log`);
    const sdkQuery = runSession({
      prompt,
      model: options.model,
      systemPromptAppend: options.systemPromptAppend,
      mcpServers: options.mcpServers,
      permissionMode: options.permissionMode ?? "bypassPermissions",
      allowedTools: options.allowedTools,
      maxTurns: options.maxTurns ?? 20,
      maxBudgetUsd: options.maxBudgetUsd,
      plugins: options.plugins,
      useSubscription: options.useSubscription,
      stderr: (line: string) => {
        const trimmed = line.trim();
        if (trimmed) {
          stderrChunks.push(trimmed);
          if (stderrChunks.length > 50) stderrChunks.shift();
          console.error(`[team-runtime:stderr] ${trimmed}`);
          // Also write to file for debugging
          try {
            fs.appendFileSync(stderrLogFile, trimmed + "\n");
          } catch {}
        }
      },
      ...(options.cwd ? { cwd: options.cwd } : {}),
    });

    let fullText = "";

    try {
      for await (const msg of sdkQuery) {
        if (msg.type === "assistant") {
          for (const block of msg.message.content) {
            if (block.type === "text" && block.text) {
              if (fullText && !fullText.endsWith("\n")) fullText += "\n";
              fullText += block.text;
            } else if (block.type === "tool_use" && emit) {
              emit({ type: "team", message: `Using tool: ${block.name}` });
            }
          }
        } else if (msg.type === "result") {
          const result = (msg as Record<string, unknown>).result;
          if (typeof result === "string") {
            fullText += result;
          } else if (Array.isArray(result)) {
            for (const block of result) {
              if (block.type === "text") {
                fullText += block.text;
              }
            }
          }
        }
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[team-runtime] Agent failed: ${errMsg}`);

      // If we captured text output before the process crashed, it likely
      // contains the real error message (e.g. "model not available").
      // Return it instead of throwing a generic "exited with code 1".
      if (fullText.trim()) {
        console.error(
          `[team-runtime] Returning captured output (${fullText.length} chars) despite exit error`,
        );
        return fullText;
      }

      if (stderrChunks.length > 0) {
        console.error(`[team-runtime] stderr output:\n${stderrChunks.join("\n")}`);
      }
      throw err;
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
