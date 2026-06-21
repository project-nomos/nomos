/**
 * Native SDK subagent definitions (Phase G of the SDK-adoption plan).
 *
 * The hand-rolled `TeamRuntime` decomposes/spawns/synthesizes workers by hand. The
 * Claude Agent SDK ships this natively: pass `agents` to `query()`, add `Agent` to
 * `allowedTools`, and the model delegates via the `Agent` tool. Subagents
 * auto-parallelize, run in fresh isolated context (only their final message
 * returns, tagged `parent_tool_use_id`), and INHERIT the parent's permission +
 * hook configuration — so the `block_critical` gate covers them structurally
 * rather than by hand-threading (which A.1 had to do for the hand-rolled path).
 *
 * Gated behind `NOMOS_NATIVE_AGENTS` (default off). The existing TeamRuntime stays
 * the default until an eval proves the native path; this is additive, not yet a
 * replacement (the ~800-LOC TeamRuntime deletion is the gated follow-on).
 */

import type { Options } from "@anthropic-ai/claude-agent-sdk";

type AgentDefinition = NonNullable<Options["agents"]>[string];

const WORKER_PROMPT = `You are a worker agent executing ONE focused, self-contained subtask delegated by a coordinator.

- You cannot see the coordinator's conversation or the other workers — everything you need is in your task.
- Do the work end to end: research, read files, run the commands, produce the deliverable the task names.
- If the task says to write a file, write it to the exact path given.
- Be thorough but stay in scope; do not expand into adjacent work other workers may own.
- Return a tight summary of what you did and where (file paths, key findings), not a narration of every step.`;

const VERIFIER_PROMPT = `You are a verification specialist. Your job is NOT to confirm an implementation works — it is to try to break it.

You are READ-ONLY: never create, modify, or delete project files, never run git write operations, never install packages. You may write ephemeral checks to a temp dir and clean up.

Two failure modes to resist: (1) verification avoidance — reading code, narrating what you "would" test, and writing PASS without running anything; (2) being seduced by the first 80% — a passing happy path while half the buttons do nothing or bad input crashes it. Your value is the last 20%: run real adversarial checks (edge cases, bad input, idempotency, orphan refs) and report exactly what you ran and observed. End with VERDICT: PASS | FAIL | PARTIAL.`;

/**
 * Build the native subagent map. Models default to `inherit` (use the parent's
 * model). The verifier is restricted to read-only tools so it can analyze but not
 * mutate. The worker inherits the full toolset.
 */
export function buildNativeAgents(): Record<string, AgentDefinition> {
  return {
    "team-worker": {
      description:
        "Execute a focused, self-contained subtask in parallel with other workers. Use when a request splits into independent pieces that can run at once (research from several angles, audit multiple modules, draft separate sections).",
      prompt: WORKER_PROMPT,
      model: "inherit",
    },
    verifier: {
      description:
        "Adversarially verify a result — try to break it, do not just confirm it. Read-only. Use after work that should be checked before it is trusted.",
      prompt: VERIFIER_PROMPT,
      tools: ["Read", "Glob", "Grep", "Bash", "WebFetch"],
      model: "inherit",
    },
  };
}

/** Whether the native-agents path is force-enabled regardless of team mode. */
export function nativeAgentsEnabled(): boolean {
  return process.env.NOMOS_NATIVE_AGENTS === "true";
}

/**
 * Escape hatch back to the hand-rolled TeamRuntime. With team mode on, Nomos uses
 * the native `agents` path by default (Phase G step 2); set NOMOS_LEGACY_TEAM=true
 * to fall back to the old coordinator/worker orchestration for one release.
 */
export function legacyTeamEnabled(): boolean {
  return process.env.NOMOS_LEGACY_TEAM === "true";
}

/** The default team mechanism is native subagents unless legacy is forced. */
export function useNativeTeam(teamMode: boolean): boolean {
  return teamMode && !legacyTeamEnabled();
}
