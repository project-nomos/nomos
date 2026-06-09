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
import { getHookRegistry } from "./registry.ts";

export function buildSdkHooks(opts: {
  sessionKey: string;
}): Record<string, HookCallbackMatcher[]> | undefined {
  const reg = getHookRegistry();
  const hasPre = reg.getHooksForEvent("PreToolUse").length > 0;
  const hasPost = reg.getHooksForEvent("PostToolUse").length > 0;
  if (!hasPre && !hasPost) return undefined; // zero-cost when unused

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

  return out;
}
