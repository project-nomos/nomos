import { describe, it, expect } from "vitest";
import { HookRegistry, getHookRegistry, initializeHooks } from "./registry.ts";

describe("HookRegistry", () => {
  it("filters hooks by event and matcher (tool name)", () => {
    const reg = new HookRegistry();
    reg.registerConfig(
      { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "true" }] }] },
      "user",
    );
    expect(reg.getHooksForEvent("PreToolUse", "Bash")).toHaveLength(1);
    // A different tool does not match the "Bash" matcher.
    expect(reg.getHooksForEvent("PreToolUse", "Read")).toHaveLength(0);
    // A different event never matches.
    expect(reg.getHooksForEvent("PostToolUse", "Bash")).toHaveLength(0);
  });

  it("a fresh registry has no hooks", () => {
    expect(new HookRegistry().getAllHooks()).toHaveLength(0);
  });

  it("initializeHooks resolves to the process-global singleton without throwing on missing files", async () => {
    const reg = await initializeHooks();
    expect(reg).toBe(getHookRegistry());
  });
});
