import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";

// Mock the executor so no real subprocess runs. The registry only imports
// executeHook from here.
vi.mock("./executor.ts", () => ({ executeHook: vi.fn() }));

import { executeHook } from "./executor.ts";
import { getHookRegistry } from "./registry.ts";
import { buildSdkHooks } from "./sdk-adapter.ts";
import type { HookInput } from "@anthropic-ai/claude-agent-sdk";

const mockExec = executeHook as unknown as Mock;

function ok(stdout = ""): unknown {
  return { success: true, stdout, stderr: "", exitCode: 0, durationMs: 1 };
}
function blocked(reason: string): unknown {
  return {
    success: false,
    stdout: "",
    stderr: "",
    exitCode: 2,
    blocked: true,
    blockReason: reason,
    durationMs: 1,
  };
}

describe("buildSdkHooks", () => {
  beforeEach(() => {
    mockExec.mockReset();
    getHookRegistry().clearSessionHooks();
  });
  afterEach(() => {
    getHookRegistry().clearSessionHooks();
  });

  it("returns undefined when no hooks are registered (zero-cost path)", () => {
    expect(buildSdkHooks({ sessionKey: "t" })).toBeUndefined();
  });

  it("PreToolUse maps a registry block to permissionDecision:deny", async () => {
    getHookRegistry().register(
      "PreToolUse",
      { type: "command", command: "true" },
      { matcher: "Bash", source: "session" },
    );
    mockExec.mockResolvedValue(blocked("nope"));

    const hooks = buildSdkHooks({ sessionKey: "t" });
    expect(hooks?.PreToolUse).toBeDefined();
    const cb = hooks!.PreToolUse![0]!.hooks[0]!;
    const out = await cb(
      { tool_name: "Bash", tool_input: { command: "rm -rf /" } } as unknown as HookInput,
      undefined,
      { signal: new AbortController().signal },
    );
    expect(out).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "nope",
      },
    });
  });

  it("PreToolUse allows (continue) when no hook blocks", async () => {
    getHookRegistry().register(
      "PreToolUse",
      { type: "command", command: "true" },
      { matcher: "Bash", source: "session" },
    );
    mockExec.mockResolvedValue(ok());

    const cb = buildSdkHooks({ sessionKey: "t" })!.PreToolUse![0]!.hooks[0]!;
    const out = await cb({ tool_name: "Bash", tool_input: {} } as unknown as HookInput, undefined, {
      signal: new AbortController().signal,
    });
    expect(out).toEqual({ continue: true });
  });

  it("matcher scoping: a Bash-matched hook does not block a Read call", async () => {
    getHookRegistry().register(
      "PreToolUse",
      { type: "command", command: "true" },
      { matcher: "Bash", source: "session" },
    );
    mockExec.mockResolvedValue(blocked("should not run"));

    const cb = buildSdkHooks({ sessionKey: "t" })!.PreToolUse![0]!.hooks[0]!;
    const out = await cb({ tool_name: "Read", tool_input: {} } as unknown as HookInput, undefined, {
      signal: new AbortController().signal,
    });
    // Read does not match the "Bash" matcher, so the hook is filtered out and never runs.
    expect(out).toEqual({ continue: true });
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("PostToolUse surfaces hook stdout as additionalContext", async () => {
    getHookRegistry().register(
      "PostToolUse",
      { type: "command", command: "true" },
      { source: "session" },
    );
    mockExec.mockResolvedValue(ok("extra context here"));

    const hooks = buildSdkHooks({ sessionKey: "t" });
    expect(hooks?.PostToolUse).toBeDefined();
    const cb = hooks!.PostToolUse![0]!.hooks[0]!;
    const out = await cb(
      { tool_name: "Bash", tool_input: {}, tool_response: "result" } as unknown as HookInput,
      undefined,
      { signal: new AbortController().signal },
    );
    expect(out).toEqual({
      hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "extra context here" },
    });
  });

  it("fires observe-only lifecycle hooks (e.g. SessionStart) without blocking", async () => {
    getHookRegistry().register(
      "SessionStart",
      { type: "command", command: "log.sh" },
      { source: "session" },
    );
    mockExec.mockResolvedValue(ok("started"));

    const hooks = buildSdkHooks({ sessionKey: "s1" });
    expect(hooks?.SessionStart).toBeDefined();
    const out = await hooks!.SessionStart![0]!.hooks[0]!({} as unknown as HookInput, undefined, {
      signal: new AbortController().signal,
    });
    // Observe-only: runs the registry hook (side effect) and never blocks.
    expect(out).toEqual({ continue: true });
    expect(mockExec).toHaveBeenCalledTimes(1);
  });

  it("does not register an event that has no hooks (zero-cost)", () => {
    getHookRegistry().register("Stop", { type: "command", command: "x" }, { source: "session" });
    const hooks = buildSdkHooks({ sessionKey: "s1" });
    expect(hooks?.Stop).toBeDefined();
    expect(hooks?.SessionEnd).toBeUndefined();
    expect(hooks?.PreToolUse).toBeUndefined();
  });
});
