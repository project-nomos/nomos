/**
 * Hook system types.
 *
 * Defines the event-driven hook system that allows customizing
 * agent behavior through shell commands, prompts, or HTTP callbacks.
 * Hooks are configured via settings files or registered programmatically.
 *
 * Adapted from Claude Code's hook system — simplified to the core
 * event types and execution modes relevant to nomos.
 */

// ── Hook Events ──

/**
 * Events that can trigger hooks.
 */
export type HookEvent =
  | "PreToolUse" // Before a tool is executed
  | "PostToolUse" // After a tool completes
  | "Notification" // When a proactive message is sent
  | "Stop" // When the agent stops processing
  | "SessionStart" // When a session begins
  | "SessionEnd" // When a session ends
  | "PreCompact" // Before conversation compaction
  | "PostCompact"; // After conversation compaction

/**
 * All valid hook event names.
 */
export const HOOK_EVENTS: readonly HookEvent[] = [
  "PreToolUse",
  "PostToolUse",
  "Notification",
  "Stop",
  "SessionStart",
  "SessionEnd",
  "PreCompact",
  "PostCompact",
];

// ── Hook Commands ──

/**
 * A shell command hook — runs a command in a subprocess.
 */
export interface CommandHook {
  type: "command";
  /** Shell command to execute. */
  command: string;
  /** Shell to use (default: "bash"). */
  shell?: string;
  /** Timeout in milliseconds (default: 30000). */
  timeout?: number;
  /** Optional condition pattern (e.g., "Bash(git *)" for PreToolUse). */
  if?: string;
}

/**
 * An HTTP webhook hook — sends a POST request.
 */
export interface HttpHook {
  type: "http";
  /** URL to POST to. */
  url: string;
  /** Timeout in milliseconds (default: 10000). */
  timeout?: number;
  /** Optional condition pattern. */
  if?: string;
}

/**
 * A prompt hook — injects a prompt into the agent's context.
 */
export interface PromptHook {
  type: "prompt";
  /** Prompt text to inject. */
  prompt: string;
  /** Optional condition pattern. */
  if?: string;
}

/**
 * Union of all hook command types.
 */
export type HookCommand = CommandHook | HttpHook | PromptHook;

// ── Hook Configuration ──

/**
 * A matcher that determines which hooks run for an event.
 * The `matcher` field is an optional pattern for filtering (e.g., tool name).
 */
export interface HookMatcher {
  /** Optional pattern to match against (e.g., "Bash" for PreToolUse). */
  matcher?: string;
  /** Hooks to run when this matcher matches. */
  hooks: HookCommand[];
}

/**
 * Full hook configuration: event → matchers → hooks.
 */
export type HookConfig = Partial<Record<HookEvent, HookMatcher[]>>;

/**
 * Source of a hook configuration.
 */
export type HookSource = "user" | "project" | "session" | "builtin";

/**
 * A registered hook with its source and event.
 */
export interface RegisteredHook {
  event: HookEvent;
  command: HookCommand;
  matcher?: string;
  source: HookSource;
}

// ── Hook Execution ──

/**
 * Context passed to hooks during execution.
 */
export interface HookContext {
  /** The event that triggered this hook. */
  event: HookEvent;
  /** Session key. */
  sessionKey: string;
  /** Tool name (for PreToolUse/PostToolUse). */
  toolName?: string;
  /** Tool input (for PreToolUse). */
  toolInput?: unknown;
  /** Tool output (for PostToolUse). */
  toolOutput?: string;
  /** Working directory. */
  cwd?: string;
}

/**
 * Result of a hook execution.
 */
export interface HookResult {
  /** Whether the hook succeeded. */
  success: boolean;
  /** Standard output. */
  stdout: string;
  /** Standard error. */
  stderr: string;
  /** Exit code (for command hooks). */
  exitCode?: number;
  /** HTTP status code (for HTTP hooks). */
  statusCode?: number;
  /** Whether the tool call should be blocked (for PreToolUse). */
  blocked?: boolean;
  /** Block reason message. */
  blockReason?: string;
  /** Duration in milliseconds. */
  durationMs: number;
}

/**
 * Hook execution events for progress tracking.
 */
export type HookExecutionEvent =
  | { type: "started"; hookName: string; event: HookEvent }
  | { type: "completed"; hookName: string; event: HookEvent; result: HookResult }
  | { type: "error"; hookName: string; event: HookEvent; error: string };
