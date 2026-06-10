# Session Management

How Nomos scopes conversations, serializes them, and resumes them across restarts. A
session is the **disposable working buffer**; durable state lives in the
[vault](memory-system.md), so rotating or losing a session is never data loss.

## Overview

Each session is one rolling SDK conversation, identified by a stable **session key**.
Messages for a key are processed one at a time (a per-session FIFO queue), and the
underlying SDK session is resumed across turns, restarts, and reconnects. When a session
outgrows the model's context window it rotates to a fresh one, and continuity survives
because the facts that matter were written to the vault, not held in the buffer.

```
incoming message
      |
      v
 session key = scope(platform, channelId, userId)   <- ScopeMode
      |
      v
 per-session FIFO queue   (serialized within a key, concurrent across keys)
      |
      v
 AgentRuntime --- resume the SDK session (sdkSessionIds cache -> DB metadata)
      |                |
      |                +-- on "prompt too long": rotate (retry without resume)
      v
 durable state -> the vault   (session can be dropped without losing memory)
```

## Session keys and scope modes

A session key decides what shares one conversation. The scope mode is set by
`NOMOS_SESSION_SCOPE` (or `app.sessionScope` in the DB), default `channel`:

| Mode                | Key format                        | One session per...                     |
| ------------------- | --------------------------------- | -------------------------------------- |
| `channel` (default) | `<platform>:<channelId>`          | channel (everyone in a room shares it) |
| `sender`            | `<platform>:<channelId>:<userId>` | user within a channel                  |
| `peer`              | `<platform>:<userId>`             | user, globally across channels         |
| `channel-peer`      | `<platform>:<channelId>:<userId>` | user per channel (most granular)       |

Each CLI session gets a unique key `cli:<uuid>`; pass `--continue` to resume the most
recent CLI session (it searches recent sessions whose key starts with `cli:`), rather than
auto-resuming a fixed key. In the daemon, the runtime derives the key as
`<platform>:<channelId>` from the incoming message.

Per-user **memory** scoping is a separate axis from session scoping: memory is keyed by the
owner that `resolveMemoryUserId` resolves (see [memory-system.md](memory-system.md)), so
two different session keys for the same person still read and write one brain in power-user
mode.

## The message queue

Messages flow into a **per-session FIFO queue** (`src/daemon/message-queue.ts`):

- **Serialized within a session** -- turns for one key run in order, never overlapping, so
  the agent never races itself on the same conversation.
- **Concurrent across sessions** -- different keys process in parallel, so one slow turn in
  one channel does not block another.

## Resume and rotation

The runtime keeps the SDK session id per key in an in-memory `sdkSessionIds` cache and
persists it to the `sessions` row's `metadata.sdkSessionId`. On each turn it:

1. Looks up the cached SDK session id for the key (falling back to the DB row), and passes
   it to the SDK as `resume`, so the prior turns are still in context.
2. Stores the new SDK session id after the turn.

This means continuity survives a process restart (the id is rehydrated from the DB) and a
fresh runtime instance (same key resumes the same conversation).

**Rotation.** If a resumed turn fails with "prompt is too long" (the buffer exceeded the
model's context window), the runtime drops the resume id and retries without it, starting a
fresh SDK session for that key. The conversation buffer resets, but durable memory is
untouched because it lives in the vault, so the next turn still knows the person.

## Ephemeral (off the record)

A session whose key contains an `ephemeral` segment (matched by `/(^|:)ephemeral(:|$)/`)
skips the entire automatic capture path: no conversation indexing, no knowledge extraction.
The deliberate memory tools still work, so "actually, remember this" can write to the vault,
but nothing is captured by default. Use this for conversations that should leave no trace.

## Storage

In `src/db/schema.sql`:

- `sessions` -- session metadata: `session_key` (unique), `agent_id`, `model`, token/cost
  counters, and `metadata` (JSONB, holds `sdkSessionId` for resume).
- `transcript_messages` -- the conversation messages (`session_id` FK, `role`, JSONB
  `content`).

## Code map

- `src/sessions/types.ts` -- `ScopeMode` + the `SessionScope` shape.
- `src/sessions/store.ts` -- builds the session key from the scope mode.
- `src/daemon/message-queue.ts` -- the per-session FIFO queue.
- `src/daemon/agent-runtime.ts` -- session-key derivation, resume, and rotation.
- `src/db/sessions.ts` -- session CRUD (`createSession`, `getSessionByKey`).
- `src/daemon/memory-indexer.ts` -- `isEphemeralSession` and the capture path.

See [memory-system.md](memory-system.md) for the durable side (the vault), and
[system-design.md](system-design.md) for where sessions sit in the overall architecture.
