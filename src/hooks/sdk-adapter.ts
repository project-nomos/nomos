/**
 * Bridge the nomos hook registry into the Claude Agent SDK's native hooks.
 *
 * The SDK runs in-process JS hook callbacks (Options.hooks) directly, so a
 * PreToolUse callback that returns permissionDecision:"deny" blocks the tool
 * call inside the SDK BEFORE execution -- this is the real interception point
 * for the registry's checkToolBlocked (exit-code-2 command hooks included).
 *
 * Returns undefined when no hooks are registered, so the common case (no
 * hooks.json) adds zero cost to a turn.
 */

import type {
  HookCallbackMatcher,
  HookInput,
  PreToolUseHookInput,
  PostToolUseHookInput,
  SyncHookJSONOutput,
} from "@anthropic-ai/claude-agent-sdk";
import type { HookEvent } from "./types.ts";
import { getHookRegistry } from "./registry.ts";

/**
 * Lifecycle events the registry can run hooks for but which never block or
 * mutate the turn -- they fire command/HTTP/prompt hooks for their side effects
 * (logging, webhooks, notifications). PreToolUse (blocking) and PostToolUse
 * (context) are handled separately. The SDK exposes all of these by the same
 * name, so the nomos event string is also the SDK hooks key.
 */
const OBSERVE_ONLY_EVENTS: HookEvent[] = [
  "Notification",
  "Stop",
  "SessionStart",
  "SessionEnd",
  "PreCompact",
  "PostCompact",
];

export function buildSdkHooks(opts: {
  sessionKey: string;
}): Record<string, HookCallbackMatcher[]> | undefined {
  const reg = getHookRegistry();
  const hasPre = reg.getHooksForEvent("PreToolUse").length > 0;
  const hasPost = reg.getHooksForEvent("PostToolUse").length > 0;

  const out: Record<string, HookCallbackMatcher[]> = {};

  if (hasPre) {
    out.PreToolUse = [
      {
        hooks: [
          async (input: HookInput): Promise<SyncHookJSONOutput> => {
            const i = input as PreToolUseHookInput;
            const reason = await reg.checkToolBlocked(i.tool_name, i.tool_input, opts.sessionKey);
            if (reason) {
              return {
                hookSpecificOutput: {
                  hookEventName: "PreToolUse",
                  permissionDecision: "deny",
                  permissionDecisionReason: reason,
                },
              };
            }
            return { continue: true };
          },
        ],
      },
    ];
  }

  if (hasPost) {
    out.PostToolUse = [
      {
        hooks: [
          async (input: HookInput): Promise<SyncHookJSONOutput> => {
            const i = input as PostToolUseHookInput;
            const results = await reg.executeHooksForEvent({
              event: "PostToolUse",
              sessionKey: opts.sessionKey,
              toolName: i.tool_name,
              toolInput: i.tool_input,
              toolOutput:
                typeof i.tool_response === "string"
                  ? i.tool_response
                  : JSON.stringify(i.tool_response),
            });
            const ctx = results
              .map((r) => r.stdout)
              .filter(Boolean)
              .join("\n");
            return ctx
              ? { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: ctx } }
              : { continue: true };
          },
        ],
      },
    ];
  }

  // Observe-only lifecycle events: run the registry hooks for their side effects
  // and never block. Gated per-event so an unused event adds nothing.
  for (const event of OBSERVE_ONLY_EVENTS) {
    if (reg.getHooksForEvent(event).length === 0) continue;
    out[event] = [
      {
        hooks: [
          async (): Promise<SyncHookJSONOutput> => {
            await reg.executeHooksForEvent({ event, sessionKey: opts.sessionKey });
            return { continue: true };
          },
        ],
      },
    ];
  }

  return Object.keys(out).length > 0 ? out : undefined;
}
