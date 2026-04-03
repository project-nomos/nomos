/**
 * Hook executor — runs hook commands (shell, HTTP, prompt).
 *
 * Handles executing hook commands with proper timeouts, environment
 * variable injection, and result parsing. Command hooks can block
 * tool execution by exiting with code 2.
 *
 * Adapted from Claude Code's execAgentHook.ts / execHttpHook.ts.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { HookCommand, HookContext, HookResult } from "./types.ts";

const execFileAsync = promisify(execFile);

/** Default timeout for command hooks (30 seconds). */
const DEFAULT_COMMAND_TIMEOUT = 30_000;

/** Default timeout for HTTP hooks (10 seconds). */
const DEFAULT_HTTP_TIMEOUT = 10_000;

/** Exit code that signals "block this tool call". */
const BLOCK_EXIT_CODE = 2;

/**
 * Execute a hook command and return the result.
 */
export async function executeHook(command: HookCommand, context: HookContext): Promise<HookResult> {
  const start = Date.now();

  try {
    switch (command.type) {
      case "command":
        return await executeCommandHook(command, context, start);
      case "http":
        return await executeHttpHook(command, context, start);
      case "prompt":
        return executePromptHook(command, start);
    }
  } catch (err) {
    return {
      success: false,
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - start,
    };
  }
}

/**
 * Execute a shell command hook.
 */
async function executeCommandHook(
  hook: { command: string; shell?: string; timeout?: number },
  context: HookContext,
  start: number,
): Promise<HookResult> {
  const timeout = hook.timeout ?? DEFAULT_COMMAND_TIMEOUT;
  const shell = hook.shell ?? "bash";

  // Build environment variables for the hook
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    NOMOS_HOOK_EVENT: context.event,
    NOMOS_SESSION_KEY: context.sessionKey,
  };
  if (context.toolName) env.NOMOS_TOOL_NAME = context.toolName;
  if (context.toolInput) env.NOMOS_TOOL_INPUT = JSON.stringify(context.toolInput);
  if (context.toolOutput) env.NOMOS_TOOL_OUTPUT = context.toolOutput;
  if (context.cwd) env.NOMOS_CWD = context.cwd;

  try {
    const { stdout, stderr } = await execFileAsync(shell, ["-c", hook.command], {
      timeout,
      env,
      cwd: context.cwd ?? process.cwd(),
      maxBuffer: 1024 * 1024, // 1MB
    });

    return {
      success: true,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
      exitCode: 0,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    const execErr = err as {
      code?: number | string;
      stdout?: string;
      stderr?: string;
      killed?: boolean;
    };

    // Exit code 2 = block the tool call
    if (execErr.code === BLOCK_EXIT_CODE) {
      return {
        success: true,
        stdout: (execErr.stdout ?? "").trim(),
        stderr: (execErr.stderr ?? "").trim(),
        exitCode: BLOCK_EXIT_CODE,
        blocked: true,
        blockReason: (execErr.stderr ?? execErr.stdout ?? "Blocked by hook").trim(),
        durationMs: Date.now() - start,
      };
    }

    // Timeout
    if (execErr.killed) {
      return {
        success: false,
        stdout: (execErr.stdout ?? "").trim(),
        stderr: `Hook timed out after ${timeout}ms`,
        exitCode: -1,
        durationMs: Date.now() - start,
      };
    }

    return {
      success: false,
      stdout: (execErr.stdout ?? "").trim(),
      stderr: (execErr.stderr ?? (err instanceof Error ? err.message : String(err))).trim(),
      exitCode: typeof execErr.code === "number" ? execErr.code : 1,
      durationMs: Date.now() - start,
    };
  }
}

/**
 * Execute an HTTP webhook hook.
 */
async function executeHttpHook(
  hook: { url: string; timeout?: number },
  context: HookContext,
  start: number,
): Promise<HookResult> {
  const timeout = hook.timeout ?? DEFAULT_HTTP_TIMEOUT;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(hook.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: context.event,
        sessionKey: context.sessionKey,
        toolName: context.toolName,
        toolInput: context.toolInput,
        toolOutput: context.toolOutput,
      }),
      signal: controller.signal,
    });

    const body = await response.text();

    // Check for block response
    let blocked = false;
    let blockReason: string | undefined;
    if (response.status === 403) {
      blocked = true;
      blockReason = body || "Blocked by webhook";
    }

    return {
      success: response.ok || response.status === 403,
      stdout: body,
      stderr: "",
      statusCode: response.status,
      blocked,
      blockReason,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return {
      success: false,
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - start,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Execute a prompt hook (returns the prompt text as stdout).
 */
function executePromptHook(hook: { prompt: string }, start: number): HookResult {
  return {
    success: true,
    stdout: hook.prompt,
    stderr: "",
    durationMs: Date.now() - start,
  };
}
