# Advanced Features

This document covers the advanced agent capabilities added to Nomos beyond the core Claude Code SDK.

## Table of Contents

- [Interactive Browser Control](#interactive-browser-control)
- [Task State Machine](#task-state-machine)
- [Task Dependency Graph](#task-dependency-graph)
- [Memory Consolidation](#memory-consolidation)
- [Sleep / Self-Resume](#sleep--self-resume)
- [Inter-Agent Messaging](#inter-agent-messaging)
- [Worktree Isolation](#worktree-isolation)
- [Verification Agent](#verification-agent)
- [Proactive Messaging](#proactive-messaging)
- [Plan Mode](#plan-mode)
- [LSP Code Intelligence](#lsp-code-intelligence)

---

## Interactive Browser Control

**Files:** `src/sdk/browser.ts`, tools in `src/sdk/tools.ts`

Full Playwright-based browser automation with persistent page sessions. The `activePage` variable persists across tool calls, enabling multi-step workflows like login flows, form filling, and scraping dynamic content.

### Tools

| Tool                 | Description                                                |
| -------------------- | ---------------------------------------------------------- |
| `browser_navigate`   | Navigate to a URL, opening a persistent browser session    |
| `browser_screenshot` | Capture viewport or full-page PNG screenshots              |
| `browser_click`      | Click elements by CSS selector (left/right/double-click)   |
| `browser_type`       | Type text into input fields with optional clear/enter      |
| `browser_select`     | Select options from `<select>` dropdowns                   |
| `browser_evaluate`   | Execute arbitrary JavaScript in page context               |
| `browser_snapshot`   | Get structured page overview (text + interactive elements) |
| `browser_close`      | Close the active browser session                           |
| `browser_fetch`      | One-shot fetch with JS rendering (no persistent session)   |

### Usage

```
Navigate to the login page, fill in credentials, and submit:

1. browser_navigate → https://app.example.com/login
2. browser_type → selector: "#email", text: "user@example.com"
3. browser_type → selector: "#password", text: "secret"
4. browser_click → selector: "button[type=submit]"
5. browser_screenshot → verify login succeeded
```

---

## Task State Machine

**Files:** `src/daemon/task-manager.ts`, `src/daemon/message-queue.ts`

Every daemon operation (agent messages, cron jobs, team workers) is tracked as a task with lifecycle states:

```
pending → running → completed | failed | killed
```

Each task has an `AbortController` for cancellation. The message queue automatically creates and manages tasks for every incoming message.

### Tools

| Tool          | Description                                          |
| ------------- | ---------------------------------------------------- |
| `task_status` | List all tasks or get details for a specific task ID |
| `task_kill`   | Kill a running task by sending an abort signal       |

### TaskSummary Fields

- `id` — UUID (use first 8 chars as short ID)
- `name`, `description` — human-readable identifiers
- `status` — current lifecycle state
- `source` — origin (cron, team worker, user request, channel)
- `owner` — worker ID or agent name
- `blocks` / `blockedBy` — dependency graph edges
- `durationMs` — elapsed time
- `error` — failure message (if failed)

---

## Task Dependency Graph

**Files:** `src/daemon/task-manager.ts`

Tasks can declare dependency relationships via `blocks` and `blockedBy` arrays. A task won't start until all its blockers are completed.

### Key Methods

- `addDependency(taskId, blockerId)` — adds a dependency edge with cycle detection
- `isReady(taskId)` — checks if all blockers are completed (active tasks + archived history)
- `getReadyTasks()` — returns pending tasks with all dependencies satisfied
- `start(taskId)` — transitions to running only if all dependencies are met

### Cycle Detection

Uses BFS-based `wouldCreateCycle()` to prevent circular dependencies before adding edges. Traverses the `blocks` graph from the target to check reachability.

### Auto-Unblock

When a task completes, it emits `task:ready` process events for all downstream dependents whose dependencies are now fully satisfied. This enables automatic pipeline execution.

```typescript
// Example: task B depends on task A
const taskA = tm.create({ name: "build", ... });
const taskB = tm.create({ name: "test", ..., blockedBy: [taskA.id] });

tm.start(taskA.id);
// ... work ...
tm.complete(taskA.id); // Emits task:ready for taskB
```

---

## Memory Consolidation

**Files:** `src/memory/consolidator.ts`

Four-phase automatic memory cleanup that keeps the vector memory store lean and relevant.

### Phases

1. **Prune stale chunks** (SQL) — deletes chunks older than 7 days with ≤1 access, excluding `correction` and `skill` categories
2. **Merge near-duplicates** (vector similarity) — finds chunk pairs with cosine similarity > 0.92 and merges them, keeping the more-accessed or newer chunk
3. **LLM review** (Haiku) — sends batches of 20 chunks to a lightweight model that decides KEEP / REWRITE / MERGE / DROP for each
4. **Decay confidence** — reduces user model confidence by 10% for entries not updated in 30+ days

### Tool

| Tool                 | Description                                  |
| -------------------- | -------------------------------------------- |
| `memory_consolidate` | Trigger a full consolidation cycle on demand |

Can also run as a scheduled cron job (see `autonomous/memory-consolidation/LOOP.md`).

### ConsolidationResult

```typescript
{
  merged: number; // Duplicate chunks merged
  pruned: number; // Stale chunks removed
  rewritten: number; // Chunks rewritten by LLM
  totalBefore: number;
  totalAfter: number;
}
```

---

## Sleep / Self-Resume

**Files:** tool in `src/sdk/tools.ts`

Allows the agent to pause execution for a specified duration and resume with a wake-up prompt. Useful for polling, waiting for deployments, or periodic monitoring within a session.

### Tool

| Tool          | Description                                                  |
| ------------- | ------------------------------------------------------------ |
| `agent_sleep` | Sleep 5–3600 seconds, then resume with a wake-up instruction |

### Behavior

- The agent pauses without consuming resources (uses `setTimeout`)
- On wake, the tool returns the `wake_prompt` for the agent to execute
- Supports early interruption via `agent:wake` process event
- The `AbortController` can cancel the sleep from outside

```
agent_sleep:
  duration_seconds: 300
  wake_prompt: "Check if the deployment completed and report status"
  reason: "Waiting for k8s rollout"
```

---

## Inter-Agent Messaging

**Files:** `src/daemon/team-mailbox.ts`, tools in `src/sdk/tools.ts`

In-memory message bus for communication between team workers and the coordinator during multi-agent execution.

### Tools

| Tool                    | Description                                         |
| ----------------------- | --------------------------------------------------- |
| `send_worker_message`   | Send a message to another worker or the coordinator |
| `check_worker_messages` | Poll for incoming messages from other agents        |

### Message Properties

- `to` — target agent (`"coordinator"` or worker name/ID)
- `from` — sender agent
- `message` — content
- `priority` — `normal` | `urgent` | `blocking`
- `timestamp` — when sent

Messages are sorted by priority (blocking > urgent > normal) when received.

---

## Worktree Isolation

**Files:** `src/daemon/team-runtime.ts`

Team workers can operate in isolated git worktrees to avoid conflicts when modifying the same repository concurrently.

### How It Works

1. `git worktree add` creates a temporary branch and working copy
2. Each worker gets its own `cwd` passed to `runSession()`
3. After completion, if the worker made no changes (`git status --porcelain` is empty), the worktree and branch are auto-cleaned
4. If changes were made, the worktree path and branch are preserved for review

### Configuration

```typescript
TeamConfig {
  worktreeIsolation?: boolean; // Enable per-worker worktrees
}
```

---

## Verification Agent

**Files:** `src/daemon/team-runtime.ts`

A read-only adversarial agent that runs after team workers complete. It executes tests, build, and lint to verify the workers' changes.

### Behavior

1. Spawned with `permissionMode: "plan"` (read-only)
2. Runs the project's test suite, build, and linter
3. Returns structured result: `PASS` | `FAIL` | `PARTIAL`
4. Includes details on what passed and what failed
5. Results are included in the coordinator's final synthesis

### Configuration

```typescript
TeamConfig {
  verification?: boolean; // Enable post-work verification
}
```

---

## Proactive Messaging

**Files:** `src/daemon/proactive-sender.ts`, `src/daemon/gateway.ts`, tool in `src/sdk/tools.ts`

Allows the agent to send messages to users without being asked — for urgent notifications, monitoring alerts, or scheduled task results.

### Tool

| Tool             | Description                                       |
| ---------------- | ------------------------------------------------- |
| `proactive_send` | Send a message to the user's notification channel |

### Architecture

Tools run in SDK context without direct access to channel adapters. The bridge works via process events:

1. Tool emits `proactive:send` event with `{ platform, channelId, content, callback }`
2. Gateway listens for the event and routes through `ChannelManager`
3. The appropriate adapter (Slack, Discord, etc.) delivers the message
4. Callback confirms delivery

Falls back to the default notification channel if no target is specified.

### Urgency Levels

- `info` — standard message
- `warning` — prefixed with `*Warning:*`
- `urgent` — prefixed with `*URGENT:*`

---

## Plan Mode

**Files:** tool in `src/sdk/tools.ts`

The agent can propose implementation plans for user review before making changes. Designed for complex, multi-step tasks where alignment is important.

### Tool

| Tool           | Description                                                          |
| -------------- | -------------------------------------------------------------------- |
| `propose_plan` | Submit a structured plan with steps, affected files, and risk levels |

### Plan Structure

```typescript
{
  title: string;           // Short title
  summary: string;         // 1-2 sentence description
  steps: [{
    description: string;   // What this step does
    files?: string[];      // Files that will be modified
    risk?: "low" | "medium" | "high";
  }];
  alternatives_considered?: string;
}
```

Plans are stored in the `config` table (key: `plan.<id>`) and returned inline for the user to approve, modify, or reject.

---

## LSP Code Intelligence

**Files:** `src/sdk/lsp.ts`, tools in `src/sdk/tools.ts`

Language Server Protocol integration providing TypeScript/JavaScript code intelligence. Spawns a `typescript-language-server` instance and communicates via LSP JSON-RPC.

### Tools

| Tool                   | Description                                                 |
| ---------------------- | ----------------------------------------------------------- |
| `lsp_go_to_definition` | Jump to where a symbol is defined                           |
| `lsp_find_references`  | Find all usages of a symbol across the project              |
| `lsp_hover`            | Get type signature and JSDoc for a symbol                   |
| `lsp_document_symbols` | List all symbols in a file with their kinds and line ranges |

### Architecture

- **Lazy initialization**: the LSP server starts on first tool call
- **Persistent process**: reused across multiple tool calls in the same session
- **File auto-opening**: files are opened in the server before querying
- **Graceful shutdown**: server is killed on process exit
- **Request timeout**: 15 seconds per LSP request

### Position Convention

- `line` is **1-based** (matching typical editor display)
- `character` is **0-based** (column offset)
- Internally converted to LSP's 0-based line convention

### Example

```
lsp_hover:
  file: src/daemon/task-manager.ts
  line: 66
  character: 14
→ "class TaskManager — Task state machine for daemon background operations..."

lsp_document_symbols:
  file: src/daemon/task-manager.ts
→ [Class] TaskManager (L66–292)
    [Method] create (L71–103)
    [Method] addDependency (L106–122)
    [Method] start (L166–173)
    ...
```
