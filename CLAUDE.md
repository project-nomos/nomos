# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A TypeScript CLI and multi-channel AI agent built on `@anthropic-ai/claude-agent-sdk`. It wraps Claude Code to get all built-in tools (Bash, Read, Write, Edit, Glob, Grep, WebSearch, etc.), agent loop, compaction, and streaming — then adds persistent sessions, vector memory, a daemon with channel integrations, scheduled tasks, 25 bundled skills, and personalization.

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
- **TypeScript**: Strict mode, ESM-only (`"type": "module"`), target ESNext, `moduleResolution: "NodeNext"`.
- **UI framework**: Ink (React for CLI) — the REPL (`src/ui/repl.tsx`) uses JSX with React 19.
- **Pre-commit hooks**: Husky + lint-staged runs `oxfmt --write` and `oxlint` on staged `.ts`/`.tsx` files.
- **Postinstall**: Automatically installs Playwright Chromium and `uvx` (Python package runner via `uv`).

### Settings UI

A separate Next.js 15 app lives in `settings/` for managing integrations via a web UI (port 3456). It has its own `package.json` and dependencies (Tailwind CSS 4, lucide-react). Run independently:

```bash
cd settings && pnpm dev          # Next.js dev server on port 3456
```

### Environment Variables (required)

```bash
DATABASE_URL=postgresql://...           # PostgreSQL with pgvector extension
# Provider — set ONE of these (SDK handles switching):
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

See `.env.example` for the full set of optional variables (model, permissions, channel tokens, embeddings, etc.).

## Architecture

### How the Two Modes Work

**CLI mode** (`pnpm dev -- chat`):

1. First-run wizard detects missing config and opens browser to `/setup` wizard (falls back to terminal prompts)
2. Loads config from DB (with .env fallback), runs migrations, builds MCP servers
3. Checks if daemon is running — if yes, connects via gRPC (`GrpcClient`); if no, runs SDK in-process
4. Starts Ink-based REPL with streaming markdown rendering

**Daemon mode** (`pnpm dev -- daemon run`):

1. Gateway boots subsystems: AgentRuntime → GrpcServer → WebSocketServer → ChannelManager → CronEngine
2. Channel adapters auto-register based on env vars (e.g., `SLACK_BOT_TOKEN` → Slack adapter)
3. Messages from all channels flow into per-session FIFO queues
4. AgentRuntime processes each message through the SDK and streams events back
5. Conversations are auto-indexed into vector memory (fire-and-forget)

### Source Structure (`src/`)

- **`index.ts`** — Entry point: loads `.env`, delegates to Commander.js program
- **`cli/`** — Commander.js commands: `chat.ts` (REPL or daemon client), `daemon.ts` (lifecycle), `wizard.ts` (first-run, opens browser to /setup wizard), `send.ts` (proactive messaging), plus config/session/db/memory/mcp-config commands
- **`sdk/`** — Claude Agent SDK wrapper:
  - `session.ts` — wraps `query()`, supports V2 session API with feature detection
  - `tools.ts` — in-process MCP server exposing `memory_search` tool
  - `slack-mcp.ts`, `discord-mcp.ts`, `telegram-mcp.ts`, `google-workspace-mcp.ts` — in-process channel MCP tools for proactive messaging
- **`daemon/`** — Long-running daemon subsystem:
  - `gateway.ts` — orchestrator (boots all subsystems, signal handlers)
  - `agent-runtime.ts` — centralized agent with cached config, `bypassPermissions` mode
  - `message-queue.ts` — per-session FIFO queue (concurrent across sessions, serialized within)
  - `grpc-server.ts` — gRPC server on port 8766 (primary protocol for CLI, web, mobile clients)
  - `websocket-server.ts` — WebSocket API on port 8765 (legacy, kept for backwards compatibility)
  - `channel-manager.ts` — adapter registry with conditional registration
  - `cron-engine.ts` — DB-backed scheduled tasks (at/every/cron syntax)
  - `streaming-responder.ts` — progressive message updates for Slack/Discord
  - `memory-indexer.ts` — auto-indexes conversation turns into vector memory
  - `channels/` — thin adapters (~50-100 LOC): `slack.ts` (Socket Mode), `slack-user.ts` (User Mode), `discord.ts`, `telegram.ts` (grammY), `whatsapp.ts` (Baileys)
  - `draft-manager.ts` — draft orchestration for Slack User Mode (approve-before-send)
- **`db/`** — PostgreSQL persistence: `client.ts` (connection pool via `postgres`), `schema.sql`, `migrate.ts`, CRUD modules for sessions, transcripts, memory, config, `app-config.ts` (app-level config CRUD mapping DB keys to NomosConfig), `integrations.ts` (unified integration store with encrypted secrets), `encryption.ts` (AES-256-GCM for secrets at rest + auto-key generation at `~/.nomos/encryption.key`), `slack-workspaces.ts`, `drafts.ts`
- **`memory/`** — `embeddings.ts` (Vertex AI gemini-embedding-001, 768 dims), `chunker.ts` (overlap chunking), `search.ts` (hybrid RRF: vector cosine + FTS)
- **`config/`** — `env.ts` (env var loader with `loadEnvConfig()` sync + `loadEnvConfigAsync()` DB-merged), `profile.ts` (user profile + agent identity + system prompt builder), `soul.ts` (SOUL.md personality), `tools-md.ts` (TOOLS.md), `agents.ts` (multi-agent configs from agents.json)
- **`ui/`** — `repl.tsx` (Ink-based REPL with gradient spinner, Catppuccin Mocha theme), `slash-commands.ts` (30+ slash commands), `banner.ts` (startup greeting), `grpc-client.ts` (gRPC client for daemon), `gateway-client.ts` (legacy WebSocket client), `theme.ts`, `markdown.ts`
- **`skills/`** — `loader.ts` (three-tier: bundled → personal → project), `frontmatter.ts` (YAML parser), `installer.ts` (dependency installer)
- **`security/`** — `tool-approval.ts` (dangerous operation detection), `pairing.ts` (8-char pairing codes), `allowlist.ts`
- **`routing/`** — `router.ts` (priority-based rule matcher for multi-agent routing)
- **`sessions/`** — `types.ts` (scope modes: sender/peer/channel/channel-peer), `store.ts`, `identity.ts`
- **`cron/`** — `types.ts` (schedule types), `scheduler.ts`, `store.ts`
- **`auto-reply/`** — `heartbeat.ts` (periodic autonomous agent checks via HEARTBEAT.md)
- **`settings/`** (repo root, separate package) — Next.js 15 web UI for setup wizard, dashboard, assistant config, channel management, and advanced settings. Routes under `src/app/api/` expose REST endpoints for config, setup, Google OAuth, Slack workspaces, and integration status. Uses Tailwind CSS 4. Key pages: `/setup` (onboarding wizard), `/dashboard` (overview), `/settings` (assistant identity + API), `/integrations/*` (channels), `/admin/*` (database + memory).

### Database Schema

Tables: `config` (key-value store), `sessions` (SDK session ID, model, tokens), `transcript_messages` (JSONB), `memory_chunks` (text + vector(768)), `memory_files` (source tracking), `pairing_requests`, `channel_allowlists`, `draft_messages` (Slack User Mode approve-before-send), `slack_user_tokens` (multi-workspace), `integrations` (unified integration config with encrypted secrets). Key indexes: IVFFlat on vector column (cosine), GIN on tsvector for FTS. Schema is in `src/db/schema.sql` — migrations are idempotent (`CREATE TABLE IF NOT EXISTS` + `DO $$ BEGIN ... END $$` blocks).

### Skills

`skills/` directory contains 25 bundled SKILL.md files with YAML frontmatter. Loaded from three tiers: bundled (`skills/`), personal (`~/.nomos/skills/`), project (`./skills/`). Content injected into the system prompt.

## Key Design Decisions

- **Claude Code IS the runtime** — don't reimplement the agent loop, tool execution, or context management
- **In-process MCP** for memory and channel tools; external MCP from `.nomos/mcp.json`
- **PostgreSQL only** — no local file storage. Sessions, transcripts, memory, config all in one DB
- **Daemon's thin adapters** (~50-100 LOC) — all agent logic centralized in `AgentRuntime`
- **gRPC primary, WebSocket legacy** — new client features should use gRPC; WebSocket kept for backwards compat
- **Config in DB, .env as fallback** — DB is source of truth; `loadEnvConfigAsync()` merges DB > env vars > defaults
- **Stable session keys** — default key is `cli:default` (not timestamp-based), enabling auto-resume
- **Per-session message queue** — serializes agent processing within a session, allows concurrency across sessions
- **Automatic conversation memory** — every daemon turn is chunked, embedded, and indexed (fire-and-forget)
- **Embeddings** via Vertex AI `gemini-embedding-001` (768 dimensions); FTS fallback when embeddings unavailable
- **Provider switching** handled entirely by SDK env vars (`ANTHROPIC_API_KEY` or `CLAUDE_CODE_USE_VERTEX`)
- **Integration secrets encrypted at rest** — AES-256-GCM via `ENCRYPTION_KEY`; auto-generated at `~/.nomos/encryption.key` on first run
- **Unified integrations table** — replaces per-integration env vars; `integrations` table stores config (JSONB), secrets (encrypted TEXT), and metadata (JSONB)
- **Web-based onboarding** — setup wizard at `/setup` replaces terminal wizard; saves all config to DB

## Coding Conventions

- Strict TypeScript; avoid `any`
- ESM-only with `.ts` extension imports (e.g., `import { foo } from "./bar.ts"`)
- Keep files under ~500 LOC; extract helpers rather than creating copies
- Use Ink (React JSX) for any terminal UI components
- Use `chalk` for colors in non-Ink code; Catppuccin Mocha palette in `src/ui/theme.ts`
