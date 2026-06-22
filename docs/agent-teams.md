# Multi-Agent Teams

Some requests are wider than one agent should handle in a single context: "research X from three angles," "audit these modules in parallel," "draft the launch plan, the risks, and the timeline." For these, Nomos can decompose the task into independent subtasks, run them as **parallel worker agents**, and synthesize one answer.

## Two ways to trigger it

Team mode is gated by `NOMOS_TEAM_MODE` (on unless set to `"false"`).

1. **Natural language (recommended)** — just ask. When the request reads like parallel work, the agent calls the in-loop `delegate_to_team` tool itself ("research the codebase, the competitors, and the brand in parallel"). This runs inside the normal turn, so Theory-of-Mind, memory capture, and cost tracking all apply.
2. **The `/team` prefix** — `/team <task>` forces team decomposition explicitly.

```text
/team research our top 3 competitors and draft a positioning one-pager
```

## How it works

1. **Decompose.** A coordinator agent breaks the task into up to `maxWorkers` self-contained subtasks. Each subtask carries everything its worker needs — workers can't see each other or the coordinator's conversation, and they run **simultaneously**, so no subtask may depend on another's output.
2. **Execute in parallel.** Each subtask runs as an independent agent session (`runSession`), optionally in its own git worktree (`worktreeIsolation`) so file-writing workers don't collide. Each worker has a turn cap (`workerMaxTurns`) and a USD budget cap (`workerBudgetUsd`, default $2).
3. **Verify (optional).** An adversarial verification agent checks the results — its job is to try to break them, not to confirm they work.
4. **Synthesize.** The coordinator merges the worker outputs into one coherent response. Failed workers are surfaced explicitly, not silently dropped.

## Safety

Workers run with `bypassPermissions` like the main agent, so they inherit the same **`block_critical` `PreToolUse` gate**: a worker cannot run a critical tool (`rm -rf`, `git push --force`, …) the main path would block. This is enforced by `TeamConfig.approvalPolicy` (default `block_critical`), threaded from the runtime config into every coordinator / worker / verifier run. Workers also receive only the base MCP tool set (no `nomos-team`), so a worker can never recurse into spawning its own team.

## Configuration

| Env var                   | Default | Effect                                     |
| ------------------------- | ------- | ------------------------------------------ |
| `NOMOS_TEAM_MODE`         | on      | Set `false` to disable team mode entirely. |
| `NOMOS_MAX_TEAM_WORKERS`  | 4       | Maximum parallel workers per task.         |
| `NOMOS_WORKER_BUDGET_USD` | 2       | USD cap per worker.                        |

Also configurable in the Settings UI (model + team settings).

## Relationship to the Claude Agent SDK

The current implementation (`src/daemon/team-runtime.ts`) orchestrates workers by hand. The Claude Agent SDK now ships a native `agents` option (`AgentDefinition` + the `Agent` tool + `parent_tool_use_id`) where subagents are model-invoked, auto-parallelized, given fresh isolated context, and **inherit the parent's permission + hook configuration** — which would make the safety property above structural rather than wired by hand. Migrating the hand-rolled core onto the native option (keeping the card rendering and worktree convention as a thin shim) is the planned direction; see `nomos-docs/sdk-adoption-plan.md` (Phase G).

## Notes

- Workers keep the MCP `ask_user` tool for clarifying questions (the native `AskUserQuestion` is not available inside subagents).
- Large fan-outs of parallel workers can hit API rate limits; prefer a handful of focused workers over one very wide dispatch.
