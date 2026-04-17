# System Design

## 1. Overview

A TypeScript CLI and multi-channel AI agent built on the `@anthropic-ai/claude-agent-sdk`. It wraps Claude Code as its agent runtime, inheriting the full tool suite (Bash, Read, Write, Edit, Glob, Grep, WebSearch, sub-agents, context compaction) and adds persistent sessions, vector memory with automatic conversation indexing and adaptive knowledge extraction, a daemon gateway with channel integrations, multi-agent team orchestration, smart model routing, custom API endpoint support, scheduled tasks, a skills system, and **digital clone** capabilities — historical data ingestion, communication style modeling, a compiled knowledge wiki, cross-channel identity graph, proactive agency, and CATE protocol integration for agent-to-agent trust.

### Design Principles

- **Claude Code IS the runtime** -- don't reimplement the agent loop, tool execution, context management, or sub-agents
- **MCP for extensibility** -- in-process and external MCP servers extend the agent's capabilities
- **PostgreSQL as the single persistence layer** -- sessions, transcripts, memory, config, cron jobs, and access control all live in one database
- **Anthropic-compatible providers** -- Anthropic direct API, Google Vertex AI, or any Anthropic-compatible proxy (Ollama + LiteLLM, etc.) via `ANTHROPIC_BASE_URL`

## 2. Architecture

```
+-----------------------------------------------------------------+
|  Channels                                                       |
|  +-------+ +---------+ +----------+ +----------+ +----------+  |
|  | Slack | | Discord | | Telegram | | WhatsApp | | Terminal |  |
|  |Adapter| | Adapter | | Adapter  | | Adapter  | | (gRPC)   |  |
|  +---+---+ +----+----+ +----+-----+ +----+-----+ +----+-----+  |
|  +----------+ +----------+                                      |
|  | iMessage | |  Email   |                                      |
|  | (chatdb/ | | (IMAP/  |                                      |
|  | BlueBub) | |  SMTP)  |                                      |
|  +----+-----+ +----+----+                                      |
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
|                                                                 |
|  +---------------+ +---------------+ +------------------------+ |
|  | Observer      | | Knowledge     | | IngestPipeline         | |
|  | (passive      | | Compiler      | | (historical data       | |
|  |  observation) | | (wiki build)  | |  + delta sync)         | |
|  +---------------+ +---------------+ +------------------------+ |
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
|  - memory_chunks       (text chunks + 768-dim embeddings +      |
|                         metadata JSONB for categorization)      |
|  - memory_files        (source file tracking for indexer)       |
|  - user_model          (accumulated user preferences/facts)     |
|  - cron_jobs           (scheduled task definitions)             |
|  - pairing_requests    (channel pairing codes with TTL)         |
|  - channel_allowlists  (per-platform user allowlists)           |
|  - draft_messages      (Slack User Mode approve-before-send)    |
|  - slack_user_tokens   (multi-workspace OAuth tokens)           |
|  - ingest_jobs         (ingestion pipeline tracking + delta)    |
|  - style_profiles      (per-contact communication style)        |
|  - wiki_articles       (compiled knowledge wiki articles)       |
|  - contacts            (cross-channel identity graph)           |
|  - contact_identities  (platform identity → contact linkage)    |
|  - commitments         (tracked promises/follow-ups)            |
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
│   ├── ingest.ts             Data ingestion CLI (nomos ingest <platform>)
│   ├── contacts.ts           Contact management CLI (nomos contacts list|link|merge)
│   └── program.ts            Commander.js program builder
├── sdk/                      Claude Agent SDK wrapper
│   ├── session.ts            SDK query() wrapper, V2 session API
│   ├── tools.ts              In-process MCP: memory_search, user_model_recall
│   ├── slack-mcp.ts          In-process Slack MCP tools
│   ├── discord-mcp.ts        In-process Discord MCP tools
│   ├── telegram-mcp.ts       In-process Telegram MCP tools
│   ├── google-workspace-mcp.ts  In-process Google Workspace MCP tools
│   └── browser.ts            Browser fetch utility
├── ingest/                   Historical data ingestion pipeline
│   ├── types.ts              IngestSource interface, IngestMessage, IngestProgress
│   ├── pipeline.ts           Orchestrator: dedup → chunk → embed → store
│   ├── dedup.ts              SHA-256 hash deduplication against memory_chunks
│   ├── delta-sync.ts         Continuous delta ingestion via CronEngine
│   ├── index.ts              Public API
│   └── sources/              Per-platform ingestion sources
│       ├── slack.ts           Slack conversations.history (sent messages only)
│       ├── gmail.ts           Gmail API (sent folder only)
│       ├── imessage.ts        chat.db bulk query (both directions)
│       └── whatsapp.ts        WhatsApp .txt export parser
├── identity/                 Cross-channel identity graph
│   ├── contacts.ts           Contact CRUD (create, search, resolve)
│   ├── identities.ts         Platform identity linking/unlinking
│   ├── auto-linker.ts        Heuristic auto-linking (fuzzy name, email match)
│   ├── relationship.ts       Relationship metadata (role, frequency, topics)
│   └── index.ts              Public API
├── proactive/                Proactive agency features
│   ├── commitment-tracker.ts Extract commitments from conversations, remind on deadline
│   ├── meeting-briefer.ts    Pre-meeting context from calendar + identity graph
│   ├── priority-triage.ts    Cross-channel priority ranking and digest
│   ├── scheduler.ts          Register proactive cron jobs via CronEngine
│   └── index.ts              Public API
├── cate/                     CATE protocol integration (agent-to-agent trust)
│   ├── integration.ts        Nomos-specific CATE setup (DID, VC, policy)
│   ├── nomos-keystore.ts     Keystore interface using src/db/encryption.ts
│   ├── nomos-transport.ts    CATE transport via Nomos gRPC/WebSocket
│   └── index.ts              Public API
├── daemon/                   Long-running daemon subsystem
│   ├── gateway.ts            Orchestrator (boots subsystems, signal handlers)
│   ├── agent-runtime.ts      Centralized agent with cached config
│   ├── team-runtime.ts       Multi-agent team orchestration (coordinator/worker pattern)
│   ├── message-queue.ts      Per-session FIFO (concurrent across sessions)
│   ├── websocket-server.ts   WebSocket API on port 8765
│   ├── channel-manager.ts    Adapter registry with lifecycle management
│   ├── draft-manager.ts      Draft creation, approval, and sending
│   ├── cron-engine.ts        DB-backed scheduled tasks
│   ├── streaming-responder.ts Progressive message updates
│   ├── memory-indexer.ts     Auto-indexes conversation turns
│   ├── observer.ts           Passive observation pipeline (read without responding)
│   ├── lifecycle.ts          PID file, signal handlers
│   ├── types.ts              Shared daemon types
│   ├── index.ts              Daemon entry point
│   └── channels/             Channel adapters (~50-100 LOC each)
│       ├── slack.ts           Slack bot (Socket Mode via @slack/bolt)
│       ├── slack-user.ts      Slack User Mode (multi-workspace)
│       ├── discord.ts         Discord (discord.js)
│       ├── telegram.ts        Telegram (grammY, long polling)
│       ├── whatsapp.ts        WhatsApp (Baileys, QR code auth)
│       ├── imessage.ts        iMessage (dual mode: chat.db or BlueBubbles)
│       ├── imessage-bluebubbles.ts  BlueBubbles REST + webhook adapter
│       ├── imessage-receiver.ts     chat.db SQLite polling + WAL watcher
│       ├── imessage-sender.ts       AppleScript send for chat.db mode
│       ├── imessage-db.ts           chat.db SQLite query helpers
│       ├── email.ts           Email (IMAP IDLE + SMTP, draft-and-approve)
│       ├── email-imap.ts      IMAP connection management and IDLE loop
│       └── email-smtp.ts      SMTP send via nodemailer
├── db/                       PostgreSQL persistence
│   ├── client.ts             Connection pool (postgres.js)
│   ├── schema.sql            Schema (10 tables)
│   ├── migrate.ts            Migration runner (inline schema fallback)
│   ├── sessions.ts           Session CRUD
│   ├── transcripts.ts        Transcript CRUD
│   ├── memory.ts             Memory chunk CRUD (with category filtering)
│   ├── user-model.ts         User model CRUD (accumulated preferences/facts)
│   ├── config.ts             Config key-value CRUD
│   ├── drafts.ts             Draft message CRUD
│   ├── slack-workspaces.ts   Slack workspace token CRUD
│   ├── style-profiles.ts     Style profile CRUD (per-contact communication style)
│   └── wiki.ts               Wiki article CRUD (compiled knowledge articles)
├── memory/                   Vector memory system
│   ├── embeddings.ts         Vertex AI gemini-embedding-001 (768 dims)
│   ├── chunker.ts            Overlap chunking
│   ├── search.ts             Hybrid RRF: vector cosine + full-text search
│   ├── extractor.ts          Knowledge extraction from conversations via LLM
│   ├── user-model.ts         User model aggregation logic
│   ├── style-model.ts        Communication style analysis (global + per-contact)
│   ├── style-prompt.ts       Convert StyleProfile → natural-language prompt
│   ├── knowledge-compiler.ts Karpathy-style wiki compilation from ingested data
│   ├── wiki-reader.ts        Read wiki articles for agent context injection
│   └── wiki-sync.ts          Sync wiki_articles table ↔ ~/.nomos/wiki/ disk
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
├── plugins/                  Plugin system (Claude marketplace integration)
│   ├── types.ts              Plugin types + default plugin list
│   ├── loader.ts             Reads installed.json, loads plugin metadata
│   └── installer.ts          Marketplace browsing, install, remove, defaults
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

Three provider modes, all using the Anthropic SDK:

- **Anthropic Direct**: `ANTHROPIC_API_KEY` env var
- **Vertex AI**: Google Cloud ADC (`CLAUDE_CODE_USE_VERTEX=1`, `GOOGLE_CLOUD_PROJECT`, `CLOUD_ML_REGION`)
- **Custom Endpoint**: `ANTHROPIC_BASE_URL` points to any Anthropic-compatible API proxy (Ollama + LiteLLM, AWS Bedrock, corporate gateway, etc.)

Provider switching is handled entirely by the SDK based on which environment variables are set. `ANTHROPIC_BASE_URL` is propagated to all child processes via the `env` option in `query()`, including team mode workers. No custom failover logic -- the SDK manages retries and errors.

### 4.2 Persistence Layer (PostgreSQL + pgvector)

All state lives in PostgreSQL. Schema defined in `src/db/schema.sql` (17 tables) with inline fallback in `src/db/migrate.ts` for bundled builds.

#### Tables

| Table                 | Purpose                                          | Key Columns                                                                        |
| --------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `config`              | Key-value settings store                         | `key` (PK), `value` (JSONB)                                                        |
| `sessions`            | Session metadata and SDK session IDs             | `session_key` (unique), `agent_id`, `model`, `metadata` (JSONB)                    |
| `transcript_messages` | Conversation messages                            | `session_id` (FK), `role`, `content` (JSONB)                                       |
| `memory_chunks`       | Text chunks with vector embeddings + metadata    | `source`, `text`, `embedding` (vector(768)), `hash`, `metadata` (JSONB)            |
| `memory_files`        | Source file tracking for incremental re-indexing | `path` (PK), `source`, `hash`, `mtime`                                             |
| `user_model`          | Accumulated user preferences and facts           | `category` + `key` (unique), `value` (JSONB), `confidence`, `source_ids`           |
| `cron_jobs`           | Scheduled task definitions                       | `schedule`, `schedule_type`, `prompt`, `enabled`                                   |
| `pairing_requests`    | Channel pairing codes with TTL                   | `code` (unique), `status`, `expires_at`                                            |
| `channel_allowlists`  | Per-platform user allowlists                     | `platform` + `user_id` (unique)                                                    |
| `draft_messages`      | Slack User Mode approve-before-send drafts       | `platform`, `channel_id`, `content`, `status`                                      |
| `slack_user_tokens`   | Multi-workspace Slack OAuth tokens               | `team_id` (unique), `access_token`, `team_name`                                    |
| `ingest_jobs`         | Ingestion pipeline tracking and delta sync       | `platform`, `status`, `messages_processed`, `last_cursor`, `delta_schedule`        |
| `style_profiles`      | Per-contact communication style models           | `contact_id` (FK, nullable for global), `scope`, `profile` (JSONB), `sample_count` |
| `wiki_articles`       | Compiled knowledge wiki articles (DB-primary)    | `path` (unique), `title`, `content`, `category`, `backlinks` (TEXT[])              |
| `contacts`            | Cross-channel unified contact records            | `display_name`, `role`, `autonomy` (auto/draft/silent), `data_consent`             |
| `contact_identities`  | Platform identity → contact linkage              | `contact_id` (FK), `platform` + `platform_user_id` (unique), `email`               |
| `commitments`         | Tracked promises and follow-ups                  | `contact_id` (FK), `description`, `deadline`, `status` (pending/completed/expired) |

#### Indexes

- **HNSW** on `memory_chunks.embedding` (cosine similarity, better recall than IVFFlat)
- **GIN** on `memory_chunks.text` (full-text search via `tsvector`)
- **GIN** on `memory_chunks.metadata` (JSONB category filtering)
- Standard B-tree indexes on foreign keys, status columns, and lookup fields

#### Session Keys

Session keys follow the pattern `<platform>:<channel_id>` (e.g., `cli:default`, `slack:C04ABCDEF`, `slack-user:T01ABC:C04ABCDEF`). The default CLI session key is `cli:default`, enabling auto-resume without timestamp-based keys.

### 4.3 MCP Servers

#### In-Process MCP: `nomos-memory`

Created via `createSdkMcpServer()` from the Agent SDK (`src/sdk/tools.ts`). Exposes tools:

- **`memory_search`** -- Hybrid vector + full-text search over `memory_chunks`. Generates an embedding for the query via Vertex AI, runs both pgvector cosine similarity and PostgreSQL `ts_rank`, then merges results using Reciprocal Rank Fusion (RRF). Falls back to text-only search when embeddings are unavailable. Supports optional `category` filter (`fact`, `preference`, `correction`, `skill`, `conversation`) for targeted recall.
- **`user_model_recall`** -- Reads accumulated knowledge about the user from the `user_model` table. Returns preferences, facts, and patterns learned from past conversations with confidence scores. Supports optional category filtering.
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

- Persistent memory across sessions and channels (`memory_search`, `user_model_recall`)
- Automatic conversation indexing into vector memory
- Adaptive memory: structured knowledge extraction and user model accumulation
- Multi-channel message routing (Slack, Discord, Telegram, WhatsApp, iMessage, Email)
- Multi-agent team orchestration (`TeamRuntime` -- coordinator/worker pattern with parallel `query()` calls)
- Smart model routing (complexity-based tier selection: simple → Haiku, moderate → Sonnet, complex → Opus)
- Custom API endpoint passthrough (`ANTHROPIC_BASE_URL`)
- Scheduled task execution (cron)
- Streaming progressive updates to channel platforms
- Approve-before-send draft workflow (Slack User Mode, extensible to all channels)
- Multi-workspace Slack support with OAuth
- Historical data ingestion with delta sync (Slack, Gmail, iMessage, WhatsApp)
- Communication style modeling (global + per-contact voice profiles)
- Compiled knowledge wiki (Karpathy-style LLM knowledge base)
- Cross-channel identity graph with auto-linking
- Passive observation mode (read and learn without responding)
- Proactive agency (commitment tracking, meeting briefs, priority triage)
- CATE protocol for agent-to-agent trust and secure communication

### 4.5 Skills System

Skills are markdown files (`SKILL.md`) with YAML frontmatter that provide domain-specific instructions injected into the system prompt.

Three-tier loading order:

1. **Bundled** -- `skills/` directory shipped with the project
2. **Personal** -- `~/.nomos/skills/<name>/SKILL.md`
3. **Project** -- `./skills/<name>/SKILL.md`

Skills support metadata for binary/OS dependencies (`requires`), installation commands (`install`), and display emoji. The bundled `skill-creator` skill enables the agent to author new SKILL.md files via conversation.

### Plugins

Plugins extend the agent with packages of skills, agents, hooks, and MCP servers from the Claude Code ecosystem. Nomos browses the Claude marketplace (a local clone at `~/.claude/plugins/marketplaces/`) and installs plugins to `~/.nomos/plugins/`.

**Loading flow:**

1. `ensureDefaultPlugins()` installs default plugins on first boot (pr-review-toolkit, skill-creator, code-review, code-simplifier)
2. `loadInstalledPlugins()` reads `~/.nomos/plugins/installed.json` and validates each plugin directory
3. `toSdkPluginConfigs()` maps to `SdkPluginConfig[]` (`{ type: 'local', path }`)
4. Passed to every `runSession({ plugins })` call — CLI, daemon, and team workers

Plugin skills are namespaced by the SDK as `plugin-name:skill-name`. CLI management via `nomos plugin list|available|install|remove|info`.

See [docs/plugins.md](plugins.md) for full details.

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
|     Detects /team prefix and delegates to TeamRuntime.
|     Passes ANTHROPIC_BASE_URL to all runSession() calls.
|
+-- TeamRuntime (when NOMOS_TEAM_MODE=true)
|     Coordinator/worker pattern for parallel task execution.
|     1. Coordinator decomposes task into subtasks via initial query().
|     2. Workers execute subtasks in parallel (independent SDK sessions).
|     3. Coordinator synthesizes worker outputs into final response.
|     Configurable maxWorkers (default: 3) and workerMaxTurns (default: 20).
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
|     When NOMOS_ADAPTIVE_MEMORY=true, also runs knowledge extraction
|     (facts, preferences, corrections) and updates the user model.
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
|     +-- IMessageAdapter      (dual: chat.db + AppleScript / BlueBubbles REST)
|     +-- EmailAdapter         (IMAP IDLE + SMTP, draft-and-approve)
|
+-- ObservationPipeline
|     Passive observation mode for channels (read without responding).
|     Routes messages through MemoryIndexer + style extractor only.
|     Configured per-adapter via mode: "respond" | "observe".
|
+-- IngestPipeline
|     Historical data ingestion: Slack, Gmail, iMessage, WhatsApp.
|     Dedup → chunk → embed → store. Cursor-based delta sync via CronEngine.
|     Auto-triggers on channel connect. Sent-only filtering for Slack/Gmail.
|
+-- KnowledgeCompiler
|     Karpathy-style wiki compilation from ingested messages.
|     Compiles topic/contact/style articles into wiki_articles table.
|     Syncs to ~/.nomos/wiki/ on disk. Runs via cron (default: every 2h).
|
+-- StyleModel
|     Analyzes sent messages to extract communication style profiles.
|     Global profile + per-contact overrides. Injected into agent system prompt.
|
+-- ProactiveScheduler
|     Commitment tracking, pre-meeting briefs, cross-channel triage.
|     Registers cron jobs for periodic checks and reminders.
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

| Adapter      | Platform Name          | Required Config                                                |
| ------------ | ---------------------- | -------------------------------------------------------------- |
| Slack (bot)  | `slack`                | `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`                           |
| Slack (user) | `slack-user:<team_id>` | DB token + `SLACK_APP_TOKEN`, or `SLACK_USER_TOKEN`            |
| Discord      | `discord`              | `DISCORD_BOT_TOKEN`                                            |
| Telegram     | `telegram`             | `TELEGRAM_BOT_TOKEN`                                           |
| WhatsApp     | `whatsapp`             | `WHATSAPP_ENABLED=true`                                        |
| iMessage     | `imessage`             | `IMESSAGE_ENABLED=true` + `IMESSAGE_MODE` (chatdb/bluebubbles) |
| Email        | `email`                | IMAP/SMTP config in `integrations` table                       |

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
5. **(Adaptive memory)** When `NOMOS_ADAPTIVE_MEMORY=true`, runs knowledge extraction and user model accumulation (see below)

This runs fire-and-forget so it never delays message delivery. The result is that all conversations -- across all channels -- become searchable via `memory_search`, enabling cross-session and cross-channel recall.

### iMessage Dual-Mode

The iMessage adapter supports two connection modes, selected via `IMESSAGE_MODE`:

- **`chatdb`** (default): macOS-only. Reads incoming messages by polling `~/Library/Messages/chat.db` (SQLite + WAL file watcher for ~200ms detection). Sends via AppleScript. Zero external dependencies.
- **`bluebubbles`**: Connects to a BlueBubbles macOS server via REST API + webhooks. The daemon can run on any platform while a Mac relays iMessages. Supports reactions, typing indicators, read receipts, attachments (up to 8MB), group management, and message effects.

A keep-alive LaunchAgent (`scripts/bluebubbles/install-keepalive.sh`) ensures Messages.app stays running for BlueBubbles. The Settings UI at `/integrations/imessage` provides mode selection, BlueBubbles server configuration, and connection testing.

### Historical Data Ingestion

The `IngestPipeline` (`src/ingest/pipeline.ts`) imports years of communication history into vector memory:

```
Source (Slack/Gmail/iMessage/WhatsApp)
  → AsyncGenerator<IngestMessage>
  → Dedup (SHA-256 hash check against memory_chunks)
  → Chunk (overlap chunking via existing chunker)
  → Embed (batch embeddings, MAX_BATCH_SIZE=250)
  → Store (memory_chunks with metadata: source, platform, direction, contact)
```

**Filtering strategy**: Slack and Gmail ingest sent messages only (your words). iMessage and WhatsApp ingest both directions for conversation context, but the style model trains exclusively on sent messages.

**Delta sync**: After initial ingestion, the pipeline registers a cron job for continuous delta sync using cursor-based pagination (Slack cursor, Gmail historyId, iMessage ROWID). Default interval: 6 hours for API-based sources, 1 hour for local sources.

**Auto-trigger**: When a channel integration is saved (via Settings UI or onboarding), the gateway auto-triggers a background ingestion job if no prior ingest exists for that platform.

### Communication Style Model

The `StyleModel` (`src/memory/style-model.ts`) analyzes the user's sent messages to learn their writing voice:

1. Queries `memory_chunks` where `metadata->>'source' = 'ingest' AND metadata->>'direction' = 'sent'`
2. Batches by contact, uses `runForkedAgent()` (Haiku) to extract: formality (1-5), avg length, vocabulary, emoji usage, punctuation, greeting/signoff patterns
3. Produces `StyleProfile` stored as JSONB in `style_profiles` table
4. Global profile (`contact_id=NULL`) + per-contact overrides
5. `StylePrompt` converts profiles to natural-language instructions injected into the agent system prompt

### Personal Knowledge Wiki

Follows the Karpathy "LLM Knowledge Base" pattern — a structured markdown wiki compiled by an LLM from raw ingested messages.

**Hybrid architecture**:

1. **Layer 1: Raw ingestion → pgvector** — chunked messages stored with embeddings for fuzzy search
2. **Layer 2: Compiled wiki → `wiki_articles` table + `~/.nomos/wiki/`** — LLM-compiled markdown articles by topic
3. **Layer 3: Knowledge graph → `contacts` + `contact_identities`** — structured relationship data

The `KnowledgeCompiler` (`src/memory/knowledge-compiler.ts`) runs periodically via cron (default: every 2h). It reads recent ingested messages, compiles/updates topic articles (`contacts/sarah.md`, `topics/kubernetes.md`, `style/global-voice.md`), and maintains `_index.md` files with summaries and backlinks.

Storage is DB-primary: `wiki_articles` table is source of truth, synced to `~/.nomos/wiki/` as a readable cache. The agent reads wiki articles first (cheap, structured), then falls back to RAG for details.

### Cross-Channel Identity Graph

The `contacts` and `contact_identities` tables provide a unified view of people across platforms:

- **Auto-linking** (`src/identity/auto-linker.ts`): Heuristic matching by display name (fuzzy), email, or user confirmation
- **Autonomy levels**: Per-contact `autonomy` field (`auto`/`draft`/`silent`) controls whether the agent auto-sends, creates drafts, or stays silent
- **Privacy**: `data_consent` field (inferred/explicit/withdrawn) tracks consent status

### Proactive Agency

Four proactive features, all registered as cron jobs via `ProactiveScheduler`:

- **Commitment tracker**: Extracts promises/follow-ups from conversations, stores in `commitments` table, triggers reminders before deadlines
- **Meeting briefer**: Pre-meeting context from Google Calendar events + identity graph + recent conversations
- **Priority triage**: Cross-channel unread aggregation, ranked by sender importance and urgency
- **Scheduler**: Registers all proactive cron jobs with the existing `CronEngine`

### CATE Protocol Integration

CATE (Consumer Agent Trust Envelope) enables secure agent-to-agent communication. The `@project-nomos/cate-sdk` library (separate repo at `cate-protocol/`) provides:

- DID-based identity (`did:key`, `did:web`)
- Verifiable Credentials ("acts-for" delegation)
- Signed + encrypted envelopes with intent classification
- Stamps (micropayment or proof-of-work) for spam prevention
- Policy engine for rate limiting and consent

Nomos consumes the SDK via three integration modules: `NomosKeystore` (wraps `src/db/encryption.ts`), `NomosTransport` (hooks into gRPC/WebSocket), and `CATEIntegration` (DID creation, VC issuance, policy config from DB).

### Adaptive Memory & User Model

When `NOMOS_ADAPTIVE_MEMORY=true`, the `MemoryIndexer` runs a post-processing pipeline after normal indexing:

```
conversation → indexConversationTurn() → extractKnowledge() → updateUserModel()
                    ↓                           ↓                      ↓
              memory_chunks              memory_chunks           user_model
              (conversation)         (fact/preference/correction)  (accumulated)
```

**Knowledge Extraction** (`src/memory/extractor.ts`):

- Takes the user message + agent response from each turn
- Sends a short extraction prompt to the SDK (using Haiku for cost efficiency)
- Extracts three categories: facts, preferences, and corrections
- Each extracted item is stored as a separate `memory_chunk` with a `metadata.category` tag
- Only runs when user message is >50 characters (skips greetings, short commands)

**User Model Accumulation** (`src/memory/user-model.ts`):

- Processes extracted knowledge into accumulated `user_model` entries
- Confidence scoring: new entries start at extraction confidence, repeated confirmations increase it (capped at 0.95), contradictions decrease it
- Corrections mark the original memory chunk as superseded via `metadata.superseded_by`

**Prompt Injection** (at startup):

- `AgentRuntime` loads the user model from the `user_model` table
- High-confidence entries (≥0.6) are injected into the system prompt as a "What I Know About You" section
- The agent also has a `user_model_recall` tool for on-demand access

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

| Variable                 | Required    | Purpose                                        |
| ------------------------ | ----------- | ---------------------------------------------- |
| `DATABASE_URL`           | Yes         | PostgreSQL connection string                   |
| `ANTHROPIC_API_KEY`      | One of      | Anthropic direct API key                       |
| `CLAUDE_CODE_USE_VERTEX` | One of      | Enable Vertex AI provider                      |
| `GOOGLE_CLOUD_PROJECT`   | With Vertex | GCP project ID                                 |
| `CLOUD_ML_REGION`        | With Vertex | GCP region (e.g., `us-east5`)                  |
| `NOMOS_MODEL`            | No          | Model override (default: `claude-sonnet-4-6`)  |
| `NOMOS_SMART_ROUTING`    | No          | Enable complexity-based model routing          |
| `NOMOS_MODEL_SIMPLE`     | No          | Model for simple queries (default: Haiku)      |
| `NOMOS_MODEL_MODERATE`   | No          | Model for moderate queries (default: Sonnet)   |
| `NOMOS_MODEL_COMPLEX`    | No          | Model for complex queries (default: Sonnet)    |
| `NOMOS_TEAM_MODE`        | No          | Enable multi-agent team orchestration          |
| `NOMOS_MAX_TEAM_WORKERS` | No          | Max parallel workers in team mode (default: 3) |
| `ANTHROPIC_BASE_URL`     | No          | Custom Anthropic-compatible API endpoint       |
| `NOMOS_ADAPTIVE_MEMORY`  | No          | Enable knowledge extraction + user model       |
| `NOMOS_EXTRACTION_MODEL` | No          | Model for extraction (default: Haiku)          |
| `SLACK_BOT_TOKEN`        | No          | Slack bot mode                                 |
| `SLACK_APP_TOKEN`        | No          | Slack Socket Mode (bot + user mode)            |
| `SLACK_CLIENT_ID`        | No          | Slack OAuth (multi-workspace user mode)        |
| `SLACK_CLIENT_SECRET`    | No          | Slack OAuth (multi-workspace user mode)        |
| `SLACK_USER_TOKEN`       | No          | Legacy single-workspace user mode              |
| `DISCORD_BOT_TOKEN`      | No          | Discord integration                            |
| `TELEGRAM_BOT_TOKEN`     | No          | Telegram integration                           |
| `WHATSAPP_ENABLED`       | No          | WhatsApp integration                           |
| `IMESSAGE_ENABLED`       | No          | iMessage integration                           |
| `IMESSAGE_MODE`          | No          | `chatdb` (default) or `bluebubbles`            |
| `BLUEBUBBLES_SERVER_URL` | No          | BlueBubbles server URL (BlueBubbles mode)      |
| `BLUEBUBBLES_PASSWORD`   | No          | BlueBubbles API password (BlueBubbles mode)    |

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

| Command                    | Description                                            |
| -------------------------- | ------------------------------------------------------ |
| `nomos chat`               | Start interactive REPL (default command)               |
| `nomos daemon start`       | Start daemon in background                             |
| `nomos daemon stop`        | Stop running daemon                                    |
| `nomos daemon restart`     | Restart daemon                                         |
| `nomos daemon status`      | Show daemon status                                     |
| `nomos daemon logs`        | Tail daemon logs                                       |
| `nomos daemon run`         | Run daemon in foreground                               |
| `nomos slack auth`         | Connect a Slack workspace (OAuth)                      |
| `nomos slack auth --token` | Connect with manual token                              |
| `nomos slack workspaces`   | List connected workspaces                              |
| `nomos slack remove <id>`  | Disconnect a workspace                                 |
| `nomos db migrate`         | Run database migrations                                |
| `nomos config get/set`     | Manage runtime config                                  |
| `nomos session list`       | List sessions                                          |
| `nomos memory index`       | Index files into memory                                |
| `nomos send`               | Send a proactive message                               |
| `nomos ingest <platform>`  | Ingest historical data (slack/gmail/imessage/whatsapp) |
| `nomos ingest status`      | Show ingestion job status                              |
| `nomos contacts list`      | List unified contacts                                  |
| `nomos contacts link`      | Link a platform identity to a contact                  |
| `nomos contacts unlink`    | Unlink a platform identity                             |
| `nomos contacts merge`     | Merge two contacts                                     |
| `nomos contacts show`      | Show contact details with linked identities            |

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
