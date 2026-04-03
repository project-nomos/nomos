/**
 * Hook registry — manages hook registration and dispatch.
 *
 * Loads hooks from three tiers (user → project → session),
 * matches them against events and tool names, and executes them
 * in order. Supports condition matching via the `if` pattern.
 *
 * Adapted from Claude Code's hook system.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { executeHook } from "./executor.ts";
import type {
  HookConfig,
  HookCommand,
  HookContext,
  HookEvent,
  HookExecutionEvent,
  HookMatcher,
  HookResult,
  HookSource,
  RegisteredHook,
} from "./types.ts";

// ── Settings File Paths ──

const HOOK_FILES: Array<{ path: string; source: HookSource }> = [
  { path: join(homedir(), ".nomos", "hooks.json"), source: "user" },
  { path: join(process.cwd(), ".nomos", "hooks.json"), source: "project" },
];

// ── Registry ──

export class HookRegistry {
  private hooks: RegisteredHook[] = [];
  private sessionHooks: RegisteredHook[] = [];
  private builtinHooks: RegisteredHook[] = [];
  private onEvent?: (event: HookExecutionEvent) => void;

  constructor(options?: { onEvent?: (event: HookExecutionEvent) => void }) {
    this.onEvent = options?.onEvent;
  }

  /**
   * Load hooks from user and project settings files.
   */
  async loadFromFiles(): Promise<void> {
    this.hooks = [];

    for (const { path, source } of HOOK_FILES) {
      try {
        const content = await readFile(path, "utf-8");
        const config = JSON.parse(content) as { hooks?: HookConfig };
        if (config.hooks) {
          this.registerConfig(config.hooks, source);
        }
      } catch {
        // File doesn't exist or is invalid — skip
      }
    }
  }

  /**
   * Register hooks from a config object.
   */
  registerConfig(config: HookConfig, source: HookSource): void {
    for (const [event, matchers] of Object.entries(config)) {
      if (!matchers) continue;
      for (const matcher of matchers as HookMatcher[]) {
        for (const command of matcher.hooks) {
          const hook: RegisteredHook = {
            event: event as HookEvent,
            command,
            matcher: matcher.matcher,
            source,
          };

          switch (source) {
            case "session":
              this.sessionHooks.push(hook);
              break;
            case "builtin":
              this.builtinHooks.push(hook);
              break;
            default:
              this.hooks.push(hook);
              break;
          }
        }
      }
    }
  }

  /**
   * Register a single hook programmatically.
   */
  register(
    event: HookEvent,
    command: HookCommand,
    options?: {
      matcher?: string;
      source?: HookSource;
    },
  ): void {
    const hook: RegisteredHook = {
      event,
      command,
      matcher: options?.matcher,
      source: options?.source ?? "builtin",
    };

    if (hook.source === "session") {
      this.sessionHooks.push(hook);
    } else if (hook.source === "builtin") {
      this.builtinHooks.push(hook);
    } else {
      this.hooks.push(hook);
    }
  }

  /**
   * Get all hooks registered for an event, optionally filtered by tool name.
   */
  getHooksForEvent(event: HookEvent, toolName?: string): RegisteredHook[] {
    const allHooks = [...this.hooks, ...this.sessionHooks, ...this.builtinHooks];
    return allHooks.filter((hook) => {
      if (hook.event !== event) return false;

      // Check matcher pattern
      if (hook.matcher && toolName) {
        return matchesPattern(hook.matcher, toolName);
      }

      // Check `if` condition
      if (hook.command.if && toolName) {
        return matchesPattern(hook.command.if, toolName);
      }

      return true;
    });
  }

  /**
   * Execute all hooks for an event and return results.
   *
   * For PreToolUse events, if any hook blocks, execution stops
   * and the block result is returned.
   */
  async executeHooksForEvent(context: HookContext): Promise<HookResult[]> {
    const hooks = this.getHooksForEvent(context.event, context.toolName);
    if (hooks.length === 0) return [];

    const results: HookResult[] = [];

    for (const hook of hooks) {
      const hookName = getHookDisplayName(hook.command);

      this.onEvent?.({
        type: "started",
        hookName,
        event: context.event,
      });

      const result = await executeHook(hook.command, context);
      results.push(result);

      this.onEvent?.({
        type: "completed",
        hookName,
        event: context.event,
        result,
      });

      // For PreToolUse: if a hook blocks, stop executing remaining hooks
      if (context.event === "PreToolUse" && result.blocked) {
        break;
      }
    }

    return results;
  }

  /**
   * Check if any PreToolUse hook would block a tool call.
   * Returns the block reason if blocked, undefined otherwise.
   */
  async checkToolBlocked(
    toolName: string,
    toolInput: unknown,
    sessionKey: string,
  ): Promise<string | undefined> {
    const results = await this.executeHooksForEvent({
      event: "PreToolUse",
      sessionKey,
      toolName,
      toolInput,
    });

    const blocked = results.find((r) => r.blocked);
    return blocked?.blockReason;
  }

  /**
   * Clear all session hooks.
   */
  clearSessionHooks(): void {
    this.sessionHooks = [];
  }

  /**
   * Clear all hooks.
   */
  clear(): void {
    this.hooks = [];
    this.sessionHooks = [];
    this.builtinHooks = [];
  }

  /**
   * Get all registered hooks for inspection.
   */
  getAllHooks(): RegisteredHook[] {
    return [...this.hooks, ...this.sessionHooks, ...this.builtinHooks];
  }
}

// ── Helpers ──

/**
 * Match a pattern against a tool name.
 * Supports glob-style patterns: "Bash(*)" matches any Bash call,
 * "Read" matches the Read tool exactly.
 */
function matchesPattern(pattern: string, toolName: string): boolean {
  // Exact match
  if (pattern === toolName) return true;

  // Simple glob: "Tool(*)" or "Tool(prefix*)"
  const parenMatch = pattern.match(/^(\w+)\((.+)\)$/);
  if (parenMatch) {
    const [, baseTool, argPattern] = parenMatch;
    if (baseTool !== toolName && baseTool !== "*") return false;
    if (argPattern === "*") return true;
    // More complex patterns could be added here
    return false;
  }

  // Wildcard: "*" matches everything
  if (pattern === "*") return true;

  return false;
}

/**
 * Get a display name for a hook command.
 */
function getHookDisplayName(command: HookCommand): string {
  switch (command.type) {
    case "command":
      return command.command.slice(0, 60);
    case "http":
      return command.url;
    case "prompt":
      return command.prompt.slice(0, 60);
  }
}

// ── Singleton ──

let _registry: HookRegistry | undefined;

/** Get or create the global hook registry. */
export function getHookRegistry(): HookRegistry {
  if (!_registry) {
    _registry = new HookRegistry();
  }
  return _registry;
}

/** Initialize hooks from config files. */
export async function initializeHooks(): Promise<HookRegistry> {
  const registry = getHookRegistry();
  await registry.loadFromFiles();
  return registry;
}
