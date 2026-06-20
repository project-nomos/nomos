# Wait-and-Resume (background work)

When the agent kicks off long async work — a CI run, a deploy, a build — it should not block the conversation or dead-end on a "waiting on CI…" message that never gets followed up. Wait-and-resume lets the agent register that work, free the turn, and be **automatically brought back into the same conversation with the result** when it finishes.

## How It Works

1. The agent calls the **`background_register`** tool with a `watch` command (how to check whether the work is done) and finishes its turn.
2. A background watcher (the `__background_watch__` cron sentinel) runs the `watch` command every minute.
3. When `watch` exits `0` (settled), the watcher **resumes the original conversation** with the captured output, on the same session, so the agent reports the outcome and takes any follow-up action.

There is no dead-end and no silently-dropped result: an in-flight task is always either still being watched or has resumed the conversation.

## The `background_register` tool

| Field     | Required | Description                                                                              |
| --------- | -------- | ---------------------------------------------------------------------------------------- |
| `summary` | yes      | Short description of what's being waited on (e.g. `deploy CI for PR #96`).               |
| `watch`   | yes      | Shell command that exits `0` once the work has settled and prints the outcome to stdout. |
| `kind`    | no       | Category: `ci` \| `deploy` \| `build` \| `command` (default `command`).                  |

### The `watch` command convention

- **exit `0`** → the work has **settled**; stdout is the result handed back to the agent (and itself conveys pass/fail, e.g. `done: success` / `done: failure`).
- **non-zero exit** → not done yet; the command is re-run on the next sweep (every minute).

Example for a GitHub Actions run:

```bash
gh run view <run-id> --json status,conclusion \
  -q 'if .status=="completed" then .conclusion else error("running") end'
```

This exits `0` with the conclusion (`success`/`failure`) once the run completes, and errors (non-zero) while it is still running.

## Where task state lives

The store is selected automatically by deployment mode, behind one `BackgroundTaskStore` interface:

| Mode                         | Substrate | Restart behavior                                                                 |
| ---------------------------- | --------- | -------------------------------------------------------------------------------- |
| **Hosted** (`REDIS_URL` set) | Redis     | Survives pod rolls; the watcher runs under a Redis lease so only one pod sweeps. |
| **Power-user** (no Redis)    | In-memory | An in-flight task is lost on a daemon restart (acceptable for a single process). |

The resume itself rides the daemon's normal per-session message queue, so it goes through the same memory, drafts, and delivery pipeline as any other turn — and lands back on the **original** conversation, not an isolated one.

## Live sessions (zero-warmup resume) — opt-in

By default each turn (including a resume) runs one-shot and the SDK re-warms. With `NOMOS_LIVE_SESSIONS=true`, the daemon holds a **streaming session open** per conversation: the initial turn and the background-task resume run through the same live loop **in-process, in-context, zero-warmup**. This is an optimization layered on top of the durable watcher above (which works either way), so it can be rolled out independently.

## Configuration

| Env var               | Default | Effect                                                                                            |
| --------------------- | ------- | ------------------------------------------------------------------------------------------------- |
| `REDIS_URL`           | unset   | When set, background-task state (and cross-pod coordination) lives in Redis; otherwise in-memory. |
| `NOMOS_LIVE_SESSIONS` | `false` | Opt in to held-open streaming sessions for in-process, zero-warmup resume.                        |

## Notes

- The watcher (`__background_watch__`) is a system cron sentinel seeded on daemon boot; it is hidden from consumer-facing task lists and runs no agent turn except the resume it enqueues.
- A settled task is marked and excluded from the pending set, so it never resumes twice (idempotent).
- The `watch` command runs in the daemon process with a 30s timeout; it has the same reach as the agent's `Bash` tool.
