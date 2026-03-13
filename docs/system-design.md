# System Design

## 1. Overview

A TypeScript CLI and multi-channel AI agent built on the `@anthropic-ai/claude-agent-sdk`. It wraps Claude Code as its agent runtime, inheriting the full tool suite (Bash, Read, Write, Edit, Glob, Grep, WebSearch, sub-agents, context compaction) and adds persistent sessions, vector memory with automatic conversation indexing, a daemon gateway with channel integrations, scheduled tasks, and a skills system.

### Design Principles

- **Claude Code IS the runtime** -- don't reimplement the agent loop, tool execution, context management, or sub-agents
- **MCP for extensibility** -- in-process and external MCP servers extend the agent's capabilities
- **PostgreSQL as the single persistence layer** -- sessions, transcripts, memory, config, cron jobs, and access control all live in one database
- **Anthropic-only provider** -- Anthropic direct API or Google Vertex AI; no multi-provider abstraction

## 2. Architecture

```
+-----------------------------------------------------------------+
|  Channels                                                       |
|  +-------+ +---------+ +----------+ +----------+ +----------+  |
|  | Slack | | Discord | | Telegram | | WhatsApp | | Terminal |  |
|  |Adapter| | Adapter | | Adapter  | | Adapter  | | (WS CLI) |  |
|  +---+---+ +----+----+ +----+-----+ +----+-----+ +----+-----+  |
|      +----------+-----------+-----------+----------+            |
|                             |                                   |
+-----------------------------------------------------------------+
                              v
+-----------------------------------------------------------------+
|  Daemon (Gateway)                                               |
|  +--------------+  +--------------+  +------------------------+ |
|  | ChannelMgr   |  | MessageQueue |  | CronEngine             | |
|  | (adapters)   |  | (per-session |  | (DB-backed scheduled   | |
|  |              |  |  FIFO)       |  |  jobs -> message queue) | |
|  +--------------+  +------+-------+  +------------------------+ |
|                           |                                     |
|       +-----------+-------+-------+-----------+                 |
|       |           |               |           |                 |
|  +----v----+ +----v--------+ +----v-----+ +---v-------------+  |
|  | Agent   | | Streaming   | | Memory   | | Pairing /       |  |
|  | Runtime | | Responder   | | Indexer  | | Access Control  |  |
|  | (SDK    | | (progressive| | (auto    | | (codes, allow-  |  |
|  |  query) | |  updates)   | |  index)  | |  lists, DM pol) |  |
|  +---------+ +-------------+ +----------+ +-----------------+  |
+-----------------------------------------------------------------+
                              v
+-----------------------------------------------------------------+
|                    Claude Code (Agent SDK)                       |
|          (Agent runtime + conversation management)              |
|                                                                 |
|   Built-in tools:              MCP Servers:                     |
|   - Bash                       - nomos-memory (in-process)  |
|   - Read / Write / Edit          memory_search, bootstrap       |
|   - Glob / Grep               - channel MCP servers (in-proc)   |
|   - WebSearch / WebFetch         slack, discord, telegram, gws  |
|   - Task (sub-agents)          - external MCP servers            |
|                                  (from .nomos/mcp.json)     |
+-----------------------------------------------------------------+
               |
     +---------+---------+
     |                   |
     v                   v
+----------+     +--------------+
| Anthropic|     |  Vertex AI   |
|   API    |     | (Anthropic   |
|          |     |   models)    |
+----------+     +--------------+
               |
               v
+-----------------------------------------------------------------+
|                  PostgreSQL + pgvector                           |
|                                                                 |
|  Tables:                                                        |
|  - config              (key-value settings)                     |
|  - sessions            (session metadata + SDK session IDs)     |
|  - transcript_messages (conversation messages, JSONB)           |
|  - memory_chunks       (text chunks + 768-dim embeddings)       |
|  - memory_files        (source file tracking for indexer)       |
|  - cron_jobs           (scheduled task definitions)             |
|  - pairing_requests    (channel pairing codes with TTL)         |
|  - channel_allowlists  (per-platform user allowlists)           |
|  - draft_messages      (Slack User Mode approve-before-send)    |
|  - slack_user_tokens   (multi-workspace OAuth tokens)           |
+-----------------------------------------------------------------+
```

## 3. Source Structure

```
src/
├── index.ts                  Entry point: loads .env, delegates to Commander.js
├── cli/                      Commander.js commands
│   ├── chat.ts               REPL or daemon client
│   ├── daemon.ts             Daemon lifecycle (start/stop/restart/status/logs/run)
│   ├── slack.ts              Slack workspace management (auth/workspaces/remove)
│   ├── wizard.ts             First-run setup wizard
│   ├── doctor.ts             Security audit
│   ├── send.ts               Proactive messaging
│   ├── config.ts             Config management
│   ├── session.ts            Session management
│   ├── db.ts                 Database operations (migrate, reset)
│   ├── memory.ts             Memory indexing commands
│   ├── mcp-config.ts         MCP server config loader
│   └── program.ts            Commander.js program builder
├── sdk/                      Claude Agent SDK wrapper
│   ├── session.ts            SDK query() wrapper, V2 session API
│   ├── tools.ts              In-process MCP: memory_search tool
│   ├── slack-mcp.ts          In-process Slack MCP tools
│   ├── discord-mcp.ts        In-process Discord MCP tools
│   ├── telegram-mcp.ts       In-process Telegram MCP tools
│   ├── google-workspace-mcp.ts  In-process Google Workspace MCP tools
│   └── browser.ts            Browser fetch utility
├── daemon/                   Long-running daemon subsystem
│   ├── gateway.ts            Orchestrator (boots subsystems, signal handlers)
│   ├── agent-runtime.ts      Centralized agent with cached config
│   ├── message-queue.ts      Per-session FIFO (concurrent across sessions)
│   ├── websocket-server.ts   WebSocket API on port 8765
│   ├── channel-manager.ts    Adapter registry with lifecycle management
│   ├── draft-manager.ts      Draft creation, approval, and sending
│   ├── cron-engine.ts        DB-backed scheduled tasks
│   ├── streaming-responder.ts Progressive message updates
│   ├── memory-indexer.ts     Auto-indexes conversation turns
│   ├── lifecycle.ts          PID file, signal handlers
│   ├── types.ts              Shared daemon types
│   ├── index.ts              Daemon entry point
│   └── channels/             Channel adapters (~50-100 LOC each)
│       ├── slack.ts           Slack bot (Socket Mode via @slack/bolt)
│       ├── slack-user.ts      Slack User Mode (multi-workspace)
│       ├── discord.ts         Discord (discord.js)
│       ├── telegram.ts        Telegram (grammY, long polling)
│       ├── whatsapp.ts        WhatsApp (Baileys, QR code auth)
│       └── imessage.ts        iMessage (macOS only, chat.db + AppleScript)
├── db/                       PostgreSQL persistence
│   ├── client.ts             Connection pool (postgres.js)
│   ├── schema.sql            Schema (10 tables)
│   ├── migrate.ts            Migration runner (inline schema fallback)
│   ├── sessions.ts           Session CRUD
│   ├── transcripts.ts        Transcript CRUD
│   ├── memory.ts             Memory chunk CRUD
│   ├── config.ts             Config key-value CRUD
│   ├── drafts.ts             Draft message CRUD
│   └── slack-workspaces.ts   Slack workspace token CRUD
├── memory/                   Vector memory system
│   ├── embeddings.ts         Vertex AI gemini-embedding-001 (768 dims)
│   ├── chunker.ts            Overlap chunking
│   └── search.ts             Hybrid RRF: vector cosine + full-text search
├── config/                   Configuration
│   ├── env.ts                Env var loader
│   ├── profile.ts            User profile + agent identity + system prompt
│   ├── soul.ts               SOUL.md personality
│   ├── tools-md.ts           TOOLS.md instructions
│   └── agents.ts             Multi-agent configs (agents.json)
├── ui/                       Terminal UI (Ink / React for CLI)
│   ├── repl.tsx              Ink-based REPL with streaming markdown
│   ├── slash-commands.ts     30+ slash commands
│   ├── banner.ts             Startup greeting
│   ├── gateway-client.ts     WebSocket client for daemon
│   ├── theme.ts              Catppuccin Mocha palette
│   ├── markdown.ts           Markdown renderer
│   ├── bootstrap.ts          First-run bootstrap flow
│   └── components/           Ink React components
├── skills/                   Skill system
│   ├── loader.ts             Three-tier: bundled → personal → project
│   ├── frontmatter.ts        YAML frontmatter parser
│   └── installer.ts          Dependency installer
├── security/                 Access control
│   ├── tool-approval.ts      Dangerous operation detection
│   ├── pairing.ts            8-char pairing codes
│   └── allowlist.ts          Per-platform allowlists
├── routing/                  Message routing
│   └── router.ts             Priority-based rule matcher
├── sessions/                 Session management
│   ├── types.ts              Scope modes (sender/peer/channel/channel-peer)
│   ├── store.ts              Session store
│   └── identity.ts           Session identity
├── cron/                     Scheduled tasks
│   ├── types.ts              Schedule types (at/every/cron)
│   ├── scheduler.ts          Scheduler
│   ├── store.ts              Cron job CRUD
│   └── index.ts              Public API
├── auto-reply/               Autonomous checks
│   └── heartbeat.ts          Periodic HEARTBEAT.md checks
└── integrations/             Standalone integration scripts (~200 LOC each)
    ├── slack.ts               Single-channel Slack (superseded by daemon)
    ├── discord.ts             Single-channel Discord
    ├── telegram.ts            Single-channel Telegram
    └── whatsapp.ts            Single-channel WhatsApp
```

## 4. Component Design

### 4.1 Provider Layer

Two authentication modes, both using the Anthropic SDK:

- **Anthropic Direct**: `ANTHROPIC_API_KEY` env var
- **Vertex AI**: Google Cloud ADC (`CLAUDE_CODE_USE_VERTEX=1`, `GOOGLE_CLOUD_PROJECT`, `CLOUD_ML_REGION`)

Provider switching is handled entirely by the SDK based on which environment variables are set. No custom failover logic -- the SDK manages retries and errors.

### 4.2 Persistence Layer (PostgreSQL + pgvector)

All state lives in PostgreSQL. Schema defined in `src/db/schema.sql` with inline fallback in `src/db/migrate.ts` for bundled builds.

#### Tables

| Table                 | Purpose                                          | Key Columns                                                     |
| --------------------- | ------------------------------------------------ | --------------------------------------------------------------- |
| `config`              | Key-value settings store                         | `key` (PK), `value` (JSONB)                                     |
| `sessions`            | Session metadata and SDK session IDs             | `session_key` (unique), `agent_id`, `model`, `metadata` (JSONB) |
| `transcript_messages` | Conversation messages                            | `session_id` (FK), `role`, `content` (JSONB)                    |
| `memory_chunks`       | Text chunks with vector embeddings               | `source`, `text`, `embedding` (vector(768)), `hash`             |
| `memory_files`        | Source file tracking for incremental re-indexing | `path` (PK), `source`, `hash`, `mtime`                          |
| `cron_jobs`           | Scheduled task definitions                       | `schedule`, `schedule_type`, `prompt`, `enabled`                |
| `pairing_requests`    | Channel pairing codes with TTL                   | `code` (unique), `status`, `expires_at`                         |
| `channel_allowlists`  | Per-platform user allowlists                     | `platform` + `user_id` (unique)                                 |
| `draft_messages`      | Slack User Mode approve-before-send drafts       | `platform`, `channel_id`, `content`, `status`                   |
| `slack_user_tokens`   | Multi-workspace Slack OAuth tokens               | `team_id` (unique), `access_token`, `team_name`                 |

#### Indexes

- **IVFFlat** on `memory_chunks.embedding` (cosine similarity, created manually after data load)
- **GIN** on `memory_chunks.text` (full-text search via `tsvector`)
- Standard B-tree indexes on foreign keys, status columns, and lookup fields

#### Session Keys

Session keys follow the pattern `<platform>:<channel_id>` (e.g., `cli:default`, `slack:C04ABCDEF`, `slack-user:T01ABC:C04ABCDEF`). The default CLI session key is `cli:default`, enabling auto-resume without timestamp-based keys.

### 4.3 MCP Servers

#### In-Process MCP: `nomos-memory`

Created via `createSdkMcpServer()` from the Agent SDK (`src/sdk/tools.ts`). Exposes two tools:

- **`memory_search`** -- Hybrid vector + full-text search over `memory_chunks`. Generates an embedding for the query via Vertex AI, runs both pgvector cosine similarity and PostgreSQL `ts_rank`, then merges results using Reciprocal Rank Fusion (RRF). Falls back to text-only search when embeddings are unavailable.
- **`bootstrap_complete`** -- Saves agent purpose, user profile, and identity during the first-run introduction conversation.

#### In-Process Channel MCP Servers

Each channel integration exposes an MCP server for proactive messaging from within agent conversations:

- `slack-mcp.ts` -- Send messages to Slack channels/users
- `discord-mcp.ts` -- Send messages to Discord channels
- `telegram-mcp.ts` -- Send messages to Telegram chats
- `google-workspace-mcp.ts` -- Gmail, Calendar, Drive, Docs, Sheets operations

#### External MCP Servers

Loaded from `.nomos/mcp.json` (project-local or `~/.nomos/mcp.json` global) and passed to the SDK alongside in-process servers.

### 4.4 Claude Code as Agent Runtime

The Agent SDK provides natively (no reimplementation needed):

| Capability              | SDK Feature                                   |
| ----------------------- | --------------------------------------------- |
| Agent conversation loop | Built-in multi-turn agent loop                |
| Tool execution          | Bash, Read, Write, Edit, Glob, Grep           |
| Sub-agent spawning      | Task tool with specialized agent types        |
| Context management      | Automatic summarization for unlimited context |
| Web access              | WebSearch + WebFetch tools                    |
| Streaming               | Real-time token streaming                     |
| Parallel execution      | Concurrent tool calls                         |

What we add via MCP and the daemon:

- Persistent memory across sessions and channels (`memory_search`)
- Automatic conversation indexing into vector memory
- Multi-channel message routing (Slack, Discord, Telegram, WhatsApp, iMessage)
- Scheduled task execution (cron)
- Streaming progressive updates to channel platforms
- Approve-before-send draft workflow (Slack User Mode)
- Multi-workspace Slack support with OAuth

### 4.5 Skills System

Skills are markdown files (`SKILL.md`) with YAML frontmatter that provide domain-specific instructions injected into the system prompt.

Three-tier loading order:

1. **Bundled** -- `skills/` directory shipped with the project
2. **Personal** -- `~/.nomos/skills/<name>/SKILL.md`
3. **Project** -- `./skills/<name>/SKILL.md`

Skills support metadata for binary/OS dependencies (`requires`), installation commands (`install`), and display emoji. The bundled `skill-creator` skill enables the agent to author new SKILL.md files via conversation.

## 5. Daemon / Gateway Architecture

### Problem

Running each messaging integration as a standalone script duplicates config loading, session management, MCP server creation, and SDK calls. It also means no message serialization -- two messages arriving simultaneously for the same conversation can trigger concurrent agent runs and session conflicts.

### Solution

A single long-running Node.js process (the **daemon**) hosts all subsystems. The `Gateway` class (`src/daemon/gateway.ts`) is the top-level orchestrator.

```
Daemon Process (Gateway)
|
+-- AgentRuntime
|     Config, identity, profile, skills, MCP servers loaded once at startup.
|     Processes messages through Claude Agent SDK (runSession).
|     Caches SDK session IDs per conversation for multi-turn resume.
|
+-- MessageQueue
|     Per-session FIFO queues (in-memory Maps).
|     Same session key -> sequential processing.
|     Different session keys -> concurrent processing.
|
+-- StreamingResponder
|     Posts a placeholder message, then throttles progressive updates
|     as text streams in. Used for platforms that support message editing
|     (Slack, Discord). Falls back to chunked send for long responses.
|
+-- MemoryIndexer
|     After each agent turn, formats the exchange (user + assistant),
|     chunks it, generates embeddings, and stores in memory_chunks
|     with source "conversation". Runs fire-and-forget.
|
+-- DraftManager
|     Orchestrates draft creation, approval, and sending for Slack User Mode.
|     Platform-keyed send functions (Map<string, SendFn>).
|     Notifies via WebSocket events and Slack bot DMs.
|
+-- WebSocketServer (ws://localhost:8765)
|     Terminal UI client connections.
|     Streams AgentEvent objects back in real time.
|     Supports draft approval/rejection commands.
|     30s heartbeat ping/pong.
|
+-- ChannelManager
|     Registers and manages channel adapter lifecycle.
|     Only starts adapters whose env vars / DB tokens are present.
|     |
|     +-- SlackAdapter         (@slack/bolt, Socket Mode, bot token)
|     +-- SlackUserAdapter     (multi-workspace, per-team xoxp- tokens)
|     +-- DiscordAdapter       (discord.js)
|     +-- TelegramAdapter      (grammY, long polling)
|     +-- WhatsAppAdapter      (Baileys, QR code auth)
|     +-- IMessageAdapter      (macOS only, chat.db + AppleScript)
|
+-- CronEngine
      DB-backed scheduled jobs (cron expressions, at/every schedules).
      Fires jobs as IncomingMessages into the message queue.
      Delivery modes: none (silent) or announce (send to channel).
      Auto-disables after 3 consecutive failures.
```

### Channel Adapters

Each adapter implements the `ChannelAdapter` interface:

```typescript
interface ChannelAdapter {
  readonly platform: string; // "slack", "slack-user:T01ABC", "discord", etc.
  start(): Promise<void>;
  stop(): Promise<void>;
  send(message: OutgoingMessage): Promise<void>;
  // Optional: for streaming progressive updates
  postMessage?(channelId: string, text: string, threadId?: string): Promise<string | undefined>;
  updateMessage?(channelId: string, messageId: string, text: string): Promise<void>;
  deleteMessage?(channelId: string, messageId: string): Promise<void>;
}
```

Adapters are intentionally thin (50-100 lines each). They handle only platform authentication, inbound event parsing, and outbound message formatting. All agent logic lives in the shared `AgentRuntime`.

| Adapter      | Platform Name          | Required Config                                     |
| ------------ | ---------------------- | --------------------------------------------------- |
| Slack (bot)  | `slack`                | `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`                |
| Slack (user) | `slack-user:<team_id>` | DB token + `SLACK_APP_TOKEN`, or `SLACK_USER_TOKEN` |
| Discord      | `discord`              | `DISCORD_BOT_TOKEN`                                 |
| Telegram     | `telegram`             | `TELEGRAM_BOT_TOKEN`                                |
| WhatsApp     | `whatsapp`             | `WHATSAPP_ENABLED=true`                             |
| iMessage     | `imessage`             | `IMESSAGE_ENABLED=true` (macOS only)                |

### Slack User Mode (Multi-Workspace)

Slack User Mode enables Nomos to act as the authenticated user. Unlike bot mode, responses go through an approve-before-send workflow:

```
1. Someone DMs you or @mentions you in a channel
2. SlackUserAdapter picks up the message via Socket Mode
3. The agent generates a response
4. Instead of sending, a draft is created in the database
5. You're notified (CLI system event + Slack bot DM with buttons)
6. You approve or reject (/approve <id> or Slack button)
7. On approval, the message is posted via your xoxp- token
```

Multi-workspace support:

- **OAuth flow**: `nomos slack auth` opens a browser for Slack OAuth, stores the `xoxp-` token per workspace in `slack_user_tokens`
- **Manual token**: `nomos slack auth --token xoxp-...` stores a token directly
- **Platform naming**: Each workspace gets platform name `slack-user:<team_id>` (e.g., `slack-user:T01ABC`)
- **Backwards compatibility**: If no DB workspaces exist but `SLACK_USER_TOKEN` is set, a single adapter starts as `slack-user:default`

### Streaming Responder

The `StreamingResponder` (`src/daemon/streaming-responder.ts`) provides real-time progressive message updates for platforms that support message editing:

1. Posts a "_Thinking..._" placeholder when agent processing begins
2. Throttles message updates at a configurable interval (default 1.5s) as text streams in
3. Shows tool-in-progress indicators (e.g., "_Using Bash..._")
4. On completion, either updates the placeholder with the final text or deletes it and falls back to the adapter's chunked `send()` for responses exceeding 4000 characters

The gateway creates a `StreamingResponder` for any adapter that implements `postMessage` and `updateMessage`.

### Automatic Conversation Memory Indexing

The `MemoryIndexer` (`src/daemon/memory-indexer.ts`) runs after each completed agent turn:

1. Formats the user message + agent response as a timestamped text block
2. Chunks the text using the standard chunker
3. Generates embeddings via `gemini-embedding-001` (falls back to text-only if unavailable)
4. Stores chunks in `memory_chunks` with `source = "conversation"` and `path` set to the session key

This runs fire-and-forget so it never delays message delivery. The result is that all conversations -- across all channels -- become searchable via `memory_search`, enabling cross-session and cross-channel recall.

### Message Flow

```
Channel message arrives
  -> Adapter parses it into IncomingMessage
  -> Gateway creates StreamingResponder (if adapter supports it)
  -> MessageQueue.enqueue(sessionKey, message, emit)
  -> Queue serializes: one message at a time per session key
  -> AgentRuntime.processMessage() -> Claude Agent SDK
  -> SDK streams events -> emit() -> StreamingResponder updates placeholder
  -> Final OutgoingMessage returned
  -> StreamingResponder.finalize() or adapter.send()
  -> MemoryIndexer.indexConversationTurn() (fire-and-forget)
```

### Terminal UI Modes

The interactive terminal (`nomos chat`) operates in two modes:

1. **Direct mode** (default): runs the Agent SDK in-process, no daemon needed
2. **Daemon mode**: terminal UI connects via WebSocket using `GatewayClient` with auto-reconnect and exponential backoff

### Lifecycle Management

- **PID file**: `~/.nomos/daemon.pid` (written on start, removed on shutdown)
- **Signal handlers**: SIGTERM, SIGINT, SIGHUP trigger graceful shutdown
- **Shutdown order** (reverse of startup): CronEngine -> ChannelManager -> WebSocketServer
- **Stale PID detection**: checks if PID file references a running process on startup

## 6. Security

### Access Control

Channel access is gated via a pairing system:

1. User sends a `/pair` command in a channel
2. System generates an 8-character pairing code with a TTL
3. Owner approves the code via CLI
4. User is added to the per-platform allowlist

DM policies can be configured per platform (open, paired-only, or disabled).

### Tool Approval

The `tool-approval.ts` module detects dangerous operations (destructive shell commands, file overwrites in sensitive paths) and can block or require confirmation depending on the configured `TOOL_APPROVAL_POLICY`.

### Slack User Mode Security

- `xoxp-` tokens are stored in the database (encrypted at rest depends on PostgreSQL configuration)
- The approve-before-send workflow ensures the agent never sends messages as the user without explicit approval
- Drafts expire after 24 hours
- OAuth tokens can be revoked via `nomos slack remove <team-id>`

## 7. Configuration

### Environment Variables

| Variable                 | Required    | Purpose                                       |
| ------------------------ | ----------- | --------------------------------------------- |
| `DATABASE_URL`           | Yes         | PostgreSQL connection string                  |
| `ANTHROPIC_API_KEY`      | One of      | Anthropic direct API key                      |
| `CLAUDE_CODE_USE_VERTEX` | One of      | Enable Vertex AI provider                     |
| `GOOGLE_CLOUD_PROJECT`   | With Vertex | GCP project ID                                |
| `CLOUD_ML_REGION`        | With Vertex | GCP region (e.g., `us-east5`)                 |
| `NOMOS_MODEL`            | No          | Model override (default: `claude-sonnet-4-6`) |
| `SLACK_BOT_TOKEN`        | No          | Slack bot mode                                |
| `SLACK_APP_TOKEN`        | No          | Slack Socket Mode (bot + user mode)           |
| `SLACK_CLIENT_ID`        | No          | Slack OAuth (multi-workspace user mode)       |
| `SLACK_CLIENT_SECRET`    | No          | Slack OAuth (multi-workspace user mode)       |
| `SLACK_USER_TOKEN`       | No          | Legacy single-workspace user mode             |
| `DISCORD_BOT_TOKEN`      | No          | Discord integration                           |
| `TELEGRAM_BOT_TOKEN`     | No          | Telegram integration                          |
| `WHATSAPP_ENABLED`       | No          | WhatsApp integration                          |
| `IMESSAGE_ENABLED`       | No          | iMessage integration (macOS only)             |

See `.env.example` for the full set of optional variables.

### MCP Server Configuration

External MCP servers are configured in `.nomos/mcp.json`:

```json
{
  "server-name": {
    "command": "npx",
    "args": ["-y", "@some/mcp-server"],
    "env": { "API_KEY": "..." }
  }
}
```

Searched in order: project-local `.nomos/mcp.json`, then global `~/.nomos/mcp.json`.

## 8. CLI Commands

| Command                    | Description                              |
| -------------------------- | ---------------------------------------- |
| `nomos chat`               | Start interactive REPL (default command) |
| `nomos daemon start`       | Start daemon in background               |
| `nomos daemon stop`        | Stop running daemon                      |
| `nomos daemon restart`     | Restart daemon                           |
| `nomos daemon status`      | Show daemon status                       |
| `nomos daemon logs`        | Tail daemon logs                         |
| `nomos daemon run`         | Run daemon in foreground                 |
| `nomos slack auth`         | Connect a Slack workspace (OAuth)        |
| `nomos slack auth --token` | Connect with manual token                |
| `nomos slack workspaces`   | List connected workspaces                |
| `nomos slack remove <id>`  | Disconnect a workspace                   |
| `nomos db migrate`         | Run database migrations                  |
| `nomos config get/set`     | Manage runtime config                    |
| `nomos session list`       | List sessions                            |
| `nomos memory index`       | Index files into memory                  |
| `nomos send`               | Send a proactive message                 |

### Slash Commands (in REPL)

Over 30 slash commands available in the interactive REPL, including `/help`, `/model`, `/thinking`, `/memory`, `/drafts`, `/approve`, `/reject`, `/slack`, `/skills`, `/agent`, `/compact`, `/status`, `/cost`, and more.

## 9. Build & Deployment

- **Package manager**: pnpm (v10.23+)
- **Runtime**: Node.js >= 22
- **Build**: tsdown (Rolldown-based), single entry `src/index.ts` -> `dist/index.js` with shebang banner
- **Linting**: Oxlint + Oxfmt (not ESLint/Prettier)
- **TypeScript**: Strict mode, ESM-only, target ES2023, `moduleResolution: "NodeNext"`
- **Testing**: Vitest, colocated `*.test.ts` files
- **UI framework**: Ink (React 19 for CLI)

### CI Gate

```bash
pnpm check    # format:check + typecheck + lint
pnpm test     # vitest run
```
