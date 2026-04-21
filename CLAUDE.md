# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A TypeScript CLI and multi-channel AI agent built on `@anthropic-ai/claude-agent-sdk`. It wraps Claude Code to get all built-in tools (Bash, Read, Write, Edit, Glob, Grep, WebSearch, etc.), agent loop, compaction, and streaming -- then adds persistent sessions, vector memory, a daemon with channel integrations, scheduled tasks, 60+ bundled skills, multi-agent team orchestration, smart model routing, custom API endpoint support, personalization, event-driven hooks, background memory consolidation (auto-dream), cost tracking, context visualization, bash safety analysis, and self-updating documentation (magic docs).

## Build & Development

Package manager is **pnpm** (v10.23+). Requires **Node >= 22**. All commands run from the repo root.

```bash
pnpm install                 # Install dependencies
pnpm build                   # Build with tsdown → dist/index.js
pnpm dev                     # Run CLI via tsx (no build needed)
pnpm dev -- chat             # Start interactive REPL
pnpm dev -- db migrate       # Run database migrations
pnpm dev -- daemon run       # Run daemon in foreground
pnpm typecheck               # tsc --noEmit
pnpm test                    # Vitest unit tests (vitest run)
pnpm test:watch              # Vitest watch mode
pnpm lint                    # oxlint
pnpm lint:fix                # oxlint --fix + oxfmt
pnpm format                  # oxfmt --write
pnpm format:check            # oxfmt --check
pnpm check                   # format:check + typecheck + lint (CI gate)
pnpm daemon:dev              # Run daemon in foreground via tsx
```

Run a single test:

```bash
npx vitest run src/path/to/file.test.ts
```

Tests are colocated with source as `*.test.ts`.

### Key Tooling

- **Build**: tsdown (Rolldown-based). Single entry `src/index.ts` → `dist/index.js` with `#!/usr/bin/env node` banner.
- **Linting/formatting**: Oxlint + Oxfmt (not ESLint/Prettier).
- **TypeScript**: Strict mode, ESM-only (`"type": "module"`), target ESNext, `moduleResolution: "NodeNext"`, `jsx: "react-jsx"`, `allowImportingTsExtensions: true`.
- **UI framework**: Ink (React for CLI) -- the REPL (`src/ui/repl.tsx`) uses JSX with React 19.
- **Testing**: Vitest with 30s test timeout. Imports (`describe`, `it`, `expect`, `vi`, etc.) must be explicit from `"vitest"` -- globals are NOT auto-imported. DB-dependent tests mock the Kysely client using `vi.mock("./client.ts")` with a `DummyDriver` (see `src/db/test-helpers.ts`). Tests are colocated as `*.test.ts` next to their source files.
- **Pre-commit hooks**: Husky runs three checks sequentially: `lint-staged` (oxfmt + oxlint on staged `.ts`/`.tsx`/`.md`/`.json` files), then `typecheck`, then `test`. All three must pass.
- **Postinstall**: Automatically installs Playwright Chromium and `uvx` (Python package runner via `uv`).

### Settings UI

A separate Next.js 15 app lives in `settings/` for managing integrations via a web UI (port 3456). It has its own `package.json` and dependencies (Tailwind CSS 4, lucide-react). Run independently:

```bash
cd settings && pnpm dev          # Next.js dev server on port 3456
```

### Environment Variables (required)

```bash
DATABASE_URL=postgresql://...           # PostgreSQL with pgvector extension
# Provider -- set ONE of these (SDK handles switching):
ANTHROPIC_API_KEY=sk-ant-...            # Anthropic direct API
# OR for Vertex AI:
CLAUDE_CODE_USE_VERTEX=1
GOOGLE_CLOUD_PROJECT=my-project
CLOUD_ML_REGION=us-east5
```

Optional but recommended:

```bash
ENCRYPTION_KEY=<64 hex chars>          # AES-256-GCM encryption for integration secrets at rest
                                        # Generate with: openssl rand -hex 32
```

Optional feature flags:

```bash
NOMOS_SMART_ROUTING=true               # Enable complexity-based model routing
NOMOS_MODEL_SIMPLE=claude-haiku-4-5    # Model for simple queries
NOMOS_MODEL_MODERATE=claude-sonnet-4-6 # Model for moderate queries
NOMOS_MODEL_COMPLEX=claude-opus-4-6    # Model for complex queries
NOMOS_TEAM_MODE=true                   # Enable multi-agent team orchestration
NOMOS_MAX_TEAM_WORKERS=3               # Max parallel workers (default: 3)
ANTHROPIC_BASE_URL=http://localhost:4000 # Custom Anthropic-compatible API endpoint
NOMOS_ADAPTIVE_MEMORY=true             # Enable knowledge extraction + user model
NOMOS_EXTRACTION_MODEL=claude-haiku-4-5 # Model for extraction (default: haiku)
```

See `.env.example` for the full set of optional variables (model, permissions, channel tokens, embeddings, etc.). The entry point loads `.env.local` first, then `.env` (both via dotenv). All settings are also configurable via the Settings UI at `settings/` (port 3456), which writes to both DB and `.env`.

## Architecture

### How the Two Modes Work

**CLI mode** (`pnpm dev -- chat`):

1. First-run wizard detects missing config and opens browser to `/setup` wizard (falls back to terminal prompts)
2. Loads config from DB (with .env fallback), runs migrations, builds MCP servers
3. Checks if daemon is running -- if yes, connects via gRPC (`GrpcClient`); if no, runs SDK in-process
4. Starts Ink-based REPL with streaming markdown rendering

**Daemon mode** (`pnpm dev -- daemon run`):

1. Gateway boots subsystems: AgentRuntime → GrpcServer → WebSocketServer → ChannelManager → CronEngine
2. Channel adapters auto-register based on env vars (e.g., `SLACK_BOT_TOKEN` → Slack adapter)
3. Messages from all channels flow into per-session FIFO queues
4. AgentRuntime processes each message through the SDK and streams events back
5. Conversations are auto-indexed into vector memory (fire-and-forget)

### Source Structure (`src/`)

- **`index.ts`** -- Entry point: loads `.env`, delegates to Commander.js program
- **`cli/`** -- Commander.js commands: `chat.ts` (REPL or daemon client), `daemon.ts` (lifecycle), `wizard.ts` (first-run, opens browser to /setup wizard), `send.ts` (proactive messaging), plus config/session/db/memory/mcp-config commands
- **`sdk/`** -- Claude Agent SDK wrapper:
  - `session.ts` -- wraps `query()`, supports V2 session API with feature detection. `RunSessionParams` accepts `systemPrompt` (full override), `anthropicBaseUrl` (custom API endpoint), and `systemPromptAppend` (append to preset). The `ANTHROPIC_BASE_URL` env var is propagated to child processes via the `env` option.
  - `tools.ts` -- in-process MCP server exposing `memory_search` and `user_model_recall` tools
  - `cost-tracker.ts` -- per-session and per-model token usage and USD cost tracking with `CostTracker` class, model pricing tiers, formatting utilities, and `getCostTracker()` singleton
  - `token-estimation.ts` -- heuristic-based token counting (`roughTokenCount`, `bytesPerTokenForFileType`, `roughTokenCountForBlock/Content/Messages`, `formatTokenCount`)
  - `retry.ts` -- `withRetry<T>()` async retry with exponential backoff + jitter, 429/529 handling, retry-after header parsing, persistent mode for daemon, abort signal support
  - `cache-break-detection.ts` -- `PromptCacheTracker` class that detects cache-invalidating changes to system prompt, tool schemas, model, or betas across API calls
  - `tool-result-storage.ts` -- `ToolResultStore` class for content deduplication via SHA-256 hashing, 2000-char threshold, 500-entry max with LRU eviction
  - `forked-agent.ts` -- `runForkedAgent()` spawns lightweight subagent queries via Haiku for background tasks (classifiers, summaries), integrates with cost tracker
  - `slack-mcp.ts`, `discord-mcp.ts`, `telegram-mcp.ts`, `google-workspace-mcp.ts`, `slack-workspace-mcp.ts` -- in-process channel MCP tools for proactive messaging
  - `browser.ts` -- Playwright-based browser automation
- **`daemon/`** -- Long-running daemon subsystem:
  - `gateway.ts` -- orchestrator (boots all subsystems, signal handlers)
  - `agent-runtime.ts` -- centralized agent with cached config, `bypassPermissions` mode. Detects `/team` prefix to delegate to `TeamRuntime`. Passes `anthropicBaseUrl` from config to all `runSession()` calls.
  - `message-queue.ts` -- per-session FIFO queue (concurrent across sessions, serialized within)
  - `grpc-server.ts` -- gRPC server on port 8766 (primary protocol for CLI, web, mobile clients)
  - `websocket-server.ts` -- WebSocket API on port 8765 (legacy, kept for backwards compatibility)
  - `channel-manager.ts` -- adapter registry with conditional registration
  - `cron-engine.ts` -- DB-backed scheduled tasks (at/every/cron syntax)
  - `streaming-responder.ts` -- progressive message updates for Slack/Discord
  - `memory-indexer.ts` -- auto-indexes conversation turns into vector memory; when adaptive memory is enabled, also runs knowledge extraction and user model updates
  - `channels/` -- thin adapters (~50-100 LOC): `slack.ts` (Socket Mode), `slack-user.ts` (User Mode), `discord.ts`, `telegram.ts` (grammY), `whatsapp.ts` (Baileys), `imessage.ts` (dual connection: chat.db or BlueBubbles; dual agent mode: passive drafts responses for Slack approval, agent responds directly to owner only -- locked by phone/Apple ID)
  - `draft-manager.ts` -- draft orchestration for Slack User Mode and iMessage passive mode (approve-before-send)
  - `team-runtime.ts` -- multi-agent team orchestration. `TeamRuntime` class decomposes tasks via a coordinator agent, spawns parallel workers via independent `runSession()` calls, collects results with `Promise.allSettled()`, and synthesizes a final response. Workers share MCP servers and permissions but get scoped system prompts. Configurable `maxWorkers` and `workerMaxTurns`. `stripTeamPrefix()` detects `/team` trigger.
- **`db/`** -- PostgreSQL persistence: `client.ts` (connection pool via `postgres`), `schema.sql`, `migrate.ts`, CRUD modules for sessions, transcripts, memory, config, `app-config.ts` (app-level config CRUD mapping DB keys to NomosConfig -- includes `app.teamMode`, `app.maxTeamWorkers`, `app.anthropicBaseUrl`, `app.smartRouting`, `app.adaptiveMemory`, `app.extractionModel`, and model tier keys), `user-model.ts` (user model CRUD -- accumulated preferences/facts from conversations), `integrations.ts` (unified integration store with encrypted secrets), `encryption.ts` (AES-256-GCM for secrets at rest + auto-key generation at `~/.nomos/encryption.key`), `slack-workspaces.ts`, `drafts.ts`
- **`memory/`** -- `embeddings.ts` (Vertex AI gemini-embedding-001, 768 dims), `chunker.ts` (overlap chunking), `search.ts` (hybrid RRF: vector cosine + FTS with optional category filtering), `extractor.ts` (knowledge extraction from conversations via lightweight LLM call), `user-model.ts` (aggregation logic that processes extracted knowledge into user model entries), `auto-dream.ts` (background memory consolidation with time/turn gating, lock-file coordination, 4-phase consolidation prompt), `magic-docs.ts` (self-updating markdown files via `<!-- MAGIC DOC: title -->` marker, staleness checking, background update via forked agent)
- **`config/`** -- `env.ts` (`NomosConfig` interface + `loadEnvConfig()` sync + `loadEnvConfigAsync()` DB-merged. Key fields: `model`, `smartRouting` + `modelTiers`, `teamMode` + `maxTeamWorkers`, `anthropicBaseUrl`, `adaptiveMemory` + `extractionModel`), `profile.ts` (user profile + agent identity + system prompt builder -- accepts `userModel` param for adaptive prompt injection), `soul.ts` (SOUL.md personality), `tools-md.ts` (TOOLS.md), `agents.ts` (multi-agent configs from agents.json)
- **`ui/`** -- `repl.tsx` (Ink-based REPL with gradient spinner, Catppuccin Mocha theme), `slash-commands.ts` (30+ slash commands), `banner.ts` (startup greeting), `grpc-client.ts` (gRPC client for daemon), `gateway-client.ts` (legacy WebSocket client), `theme.ts`, `markdown.ts`, `components/ContextVisualization.tsx` (Ink bar chart showing context window usage by section with color-coded legend and warnings)
- **`identity/`** -- Identity graph: `contacts.ts` (contact CRUD, merge, search), `identities.ts` (cross-channel identity resolution), `relationship.ts` (JSONB relationship data, context enrichment), `auto-linker.ts` (automatic identity linking across channels)
- **`ingest/`** -- Conversation ingestion pipeline: `pipeline.ts` (orchestrator), `types.ts` (job types), `dedup.ts` (deduplication), `delta-sync.ts` (incremental sync). `sources/` has per-channel importers: `slack.ts`, `discord.ts`, `telegram.ts`, `gmail.ts`, `imessage.ts`, `whatsapp.ts`
- **`proactive/`** -- Proactive agency: `commitment-tracker.ts` (tracks promises/commitments with interval-based follow-up), `meeting-briefer.ts` (pre-meeting context), `priority-triage.ts` (message prioritization), `scheduler.ts` (proactive scheduling)
- **`cate/`** -- CATE protocol (Consumer Agent Trust Envelope) integration: `integration.ts` (agent-to-agent communication), `nomos-keystore.ts` (key management with DB-backed LIKE prefix search), `nomos-transport.ts` (message transport). Uses `@project-nomos/cate-sdk` npm package.
- **`skills/`** -- `loader.ts` (three-tier: bundled → personal → project), `frontmatter.ts` (YAML parser), `installer.ts` (dependency installer)
- **`plugins/`** -- Claude marketplace plugin system: `types.ts` (plugin types, `DEFAULT_PLUGINS` list), `loader.ts` (reads `~/.nomos/plugins/installed.json`, loads plugin metadata, `toSdkPluginConfigs()`), `installer.ts` (browses `~/.claude/plugins/marketplaces/`, install/remove to `~/.nomos/plugins/`, `ensureDefaultPlugins()` auto-installs defaults on first boot)
- **`security/`** -- `tool-approval.ts` (dangerous operation detection), `pairing.ts` (8-char pairing codes), `allowlist.ts`, `bash-analyzer.ts` (safety-focused command analysis with risk levels: destructive commands, dangerous flags, network access, elevated privileges, destructive git ops)
- **`hooks/`** -- Event-driven hook system: `types.ts` (HookEvent union: PreToolUse, PostToolUse, Notification, Stop, SessionStart/End, Pre/PostCompact), `executor.ts` (dispatches to command/HTTP/prompt handlers, exit code 2 = block), `registry.ts` (loads from `~/.nomos/hooks.json` and `.nomos/hooks.json`, pattern matching with glob support, `getHookRegistry()` singleton)
- **`routing/`** -- `router.ts` (priority-based rule matcher for multi-agent routing)
- **`sessions/`** -- `types.ts` (scope modes: sender/peer/channel/channel-peer), `store.ts`, `identity.ts`
- **`cron/`** -- `types.ts` (schedule types), `scheduler.ts`, `store.ts`
- **`auto-reply/`** -- `heartbeat.ts` (periodic autonomous agent checks via HEARTBEAT.md)
- **`settings/`** (repo root, separate package) -- Next.js 15 web UI for setup wizard, dashboard, assistant config, channel management, and advanced settings. Routes under `src/app/api/` expose REST endpoints for config, setup, Google OAuth, Slack workspaces, and integration status. The `/api/env` route handles reading/writing all config to both DB and `.env` (DB primary, `.env` secondary sync). Uses Tailwind CSS 4. Key pages: `/setup` (onboarding wizard), `/dashboard` (overview), `/settings` (assistant identity, model configuration with smart routing + tier selectors, custom API endpoint, multi-agent team mode, adaptive memory toggle + extraction model, permissions), `/integrations/*` (channels), `/admin/*` (database, memory, extensions, ingestion, proactive, costs, context window visualization).

### Database Schema

19 tables in `src/db/schema.sql`: `config` (key-value store), `sessions` (SDK session ID, model, tokens, cost tracking), `transcript_messages` (JSONB), `memory_chunks` (text + vector(768) + metadata JSONB for categorization), `user_model` (accumulated user preferences/facts with confidence scores, unique on `(category, key)`), `pairing_requests`, `channel_allowlists`, `draft_messages` (Slack User Mode approve-before-send), `slack_user_tokens` (multi-workspace), `integrations` (unified integration config with encrypted secrets), `agent_permissions` (persistent "always allow" rules), `cron_jobs` (scheduled task definitions with schedule type, delivery mode, error tracking), `cron_runs` (execution history with timing, success/failure, session key), `ingest_jobs` (channel conversation import tracking), `style_profiles` (writing style analysis with `IS NOT DISTINCT FROM` null handling), `wiki_articles` (knowledge wiki with FTS), `contacts` (identity graph -- people), `contact_identities` (cross-channel identity mappings), `commitments` (tracked promises with follow-up scheduling). Key indexes: IVFFlat on vector column (cosine), GIN on tsvector for FTS, GIN on metadata JSONB. Schema is in `src/db/schema.sql` -- migrations are idempotent (`CREATE TABLE IF NOT EXISTS` + `DO $$ BEGIN ... END $$` blocks).

### gRPC Protocol

`proto/nomos.proto` defines the `NomosAgent` service with RPCs: `Chat` (bidirectional streaming), `Command`, `GetStatus`, `ListSessions`, `GetSession`, draft management (`ListDrafts`/`ApproveDraft`/`RejectDraft`), and `Ping`. The gRPC server runs on port 8766.

### Skills

`skills/` directory contains 35 bundled SKILL.md files with YAML frontmatter. Loaded from three tiers: bundled (`skills/`), personal (`~/.nomos/skills/`), project (`./skills/`). Content injected into the system prompt.

## Key Design Decisions

- **Claude Code IS the runtime** -- don't reimplement the agent loop, tool execution, or context management
- **In-process MCP** for memory and channel tools; external MCP from `.nomos/mcp.json`
- **PostgreSQL only** -- no local file storage. Sessions, transcripts, memory, config all in one DB
- **Daemon's thin adapters** (~50-100 LOC) -- all agent logic centralized in `AgentRuntime`
- **gRPC primary, WebSocket legacy** -- new client features should use gRPC; WebSocket kept for backwards compat
- **Config in DB, .env as fallback** -- DB is source of truth; `loadEnvConfigAsync()` merges DB > env vars > defaults
- **Stable session keys** -- default key is `cli:default` (not timestamp-based), enabling auto-resume
- **Per-session message queue** -- serializes agent processing within a session, allows concurrency across sessions
- **Automatic conversation memory** -- every daemon turn is chunked, embedded, and indexed (fire-and-forget). When adaptive memory is enabled, also extracts structured knowledge (facts, preferences, corrections) and accumulates a user model
- **Adaptive memory** -- opt-in (`NOMOS_ADAPTIVE_MEMORY=true`). Uses lightweight LLM call (Haiku) to extract knowledge from conversations. Accumulated user model is injected into system prompt and accessible via `user_model_recall` tool. Confidence-weighted: repeated confirmations increase, contradictions decrease
- **Embeddings** via Vertex AI `gemini-embedding-001` (768 dimensions); FTS fallback when embeddings unavailable
- **Provider switching** handled entirely by SDK env vars (`ANTHROPIC_API_KEY` or `CLAUDE_CODE_USE_VERTEX`)
- **Integration secrets encrypted at rest** -- AES-256-GCM via `ENCRYPTION_KEY`; auto-generated at `~/.nomos/encryption.key` on first run
- **Unified integrations table** -- replaces per-integration env vars; `integrations` table stores config (JSONB), secrets (encrypted TEXT), and metadata (JSONB)
- **Web-based onboarding** -- setup wizard at `/setup` replaces terminal wizard; saves all config to DB
- **Multi-agent teams** -- coordinator/worker pattern via `TeamRuntime`. Coordinator decomposes tasks, spawns parallel workers via independent `runSession()` calls, synthesizes results. Triggered by `/team` prefix. Workers get scoped system prompts but share MCP servers.
- **Custom API endpoints** -- `ANTHROPIC_BASE_URL` propagated via `env` option in `query()` to all SDK sessions including team workers. Enables Ollama (via LiteLLM proxy), Bedrock, or any Anthropic-compatible endpoint.
- **Smart model routing** -- `smartRouting` flag + `modelTiers` (simple/moderate/complex) allow cost optimization by routing queries to different models based on complexity. Configured via env vars or Settings UI.
- **Hook system** -- event-driven extensibility via `~/.nomos/hooks.json` and `.nomos/hooks.json`. Supports command (subprocess), HTTP (webhook POST), and prompt (return text) hook types. Pattern matching on tool names with glob support. Exit code 2 blocks tool execution. Events: PreToolUse, PostToolUse, Notification, Stop, SessionStart/End, Pre/PostCompact.
- **Auto-Dream** -- background memory consolidation triggered by time (1hr) + turn count (10) gates. Lock-file coordination prevents concurrent consolidation. 4-phase prompt: Orient → Gather → Consolidate → Prune. State persisted at `~/.nomos/auto-dream/`.
- **Magic Docs** -- markdown files with `<!-- MAGIC DOC: title -->` marker are auto-updated when stale. Staleness checked via update interval (1hr) + file mtime. Background update via forked agent. State at `~/.nomos/magic-docs-state.json`.
- **Cost tracking** -- per-model pricing tiers (Haiku $1/$5, Sonnet $3/$15, Opus $5/$25), session cost summaries, model name canonicalization. Singleton `CostTracker` accumulates across turns. Settings UI at `/admin/costs`.
- **Context visualization** -- Ink bar chart (50 chars) and Settings UI page showing context window usage by section (system prompt, conversation, tools, memory, skills) with color-coded legend and capacity warnings.
- **Bash safety analysis** -- lightweight command analysis detecting destructive commands, dangerous flags, network access, elevated privileges, and destructive git operations. Risk levels: safe/low/medium/high/critical.
- **Tool result deduplication** -- SHA-256 content hashing with 2000-char threshold. LRU eviction at 500 entries (bottom 25%). Replaces large repeated results with references.
- **Retry with adaptive backoff** -- exponential backoff with jitter, retry-after header parsing, 429/529 detection. Persistent mode for daemon retries indefinitely. Abort signal support.
- **Prompt cache break detection** -- tracks SHA-256 hash of system prompt + tool schemas + model + betas. Logs warnings when cache-invalidating changes detected between API calls.
- **Forked agents** -- lightweight subagent queries via Haiku for background tasks (classifiers, summaries, magic doc updates). Cost tracked in global singleton. `runParallelForks()` for concurrent execution.
- **Plugins** -- Claude marketplace integration. Browses `~/.claude/plugins/marketplaces/` (Claude Code's local clone), installs to `~/.nomos/plugins/`. Passed as `SdkPluginConfig[]` to every `query()` call. Default plugins (pr-review-toolkit, skill-creator, code-review, code-simplifier) auto-installed on first boot via `ensureDefaultPlugins()`. CLI: `nomos plugin list|available|install|remove|info`. Fetched at build time via `scripts/fetch-plugins.sh` (uses Node.js for JSON, not Python).
- **Identity graph** -- cross-channel contact resolution. `contacts` + `contact_identities` tables link the same person across Slack, Discord, Telegram, email, etc. Auto-linker detects identity matches. Relationship data stored as JSONB.
- **Ingestion pipeline** -- imports historical conversations from channels (Slack, Discord, Telegram, Gmail, iMessage, WhatsApp) into memory. Delta-sync for incremental updates, dedup to avoid re-indexing. Jobs tracked in `ingest_jobs` table. Settings UI at `/admin/ingestion`.
- **Proactive agency** -- commitment tracking (extracts promises from conversations, schedules follow-ups), meeting briefer (pre-meeting context assembly), priority triage (message importance scoring). Settings UI at `/admin/proactive`.
- **CATE protocol** -- Consumer Agent Trust Envelope for agent-to-agent communication. Uses `@project-nomos/cate-sdk` (published to GitHub Packages). DB-backed keystore for cryptographic identity.

## Coding Conventions

- Strict TypeScript; avoid `any`
- ESM-only with `.ts` extension imports (e.g., `import { foo } from "./bar.ts"`)
- Keep files under ~500 LOC; extract helpers rather than creating copies
- Use Ink (React JSX) for any terminal UI components
- Use `chalk` for colors in non-Ink code; Catppuccin Mocha palette in `src/ui/theme.ts`
- DB schema changes must be idempotent (`CREATE TABLE IF NOT EXISTS`, `DO $$ BEGIN ... END $$` blocks)
- Use **Kysely** for type-safe SQL queries via `getKysely()` from `src/db/client.ts`. Database types are in `src/db/types.ts`. Raw `postgres` (via `getDb()`) is only used in `migrate.ts`, `routing/store.ts`, and `sessions/identity.ts`
- Validation with `zod` (v4)
