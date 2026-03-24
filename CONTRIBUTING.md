# Contributing to Nomos

## Development Environment

### Prerequisites

- **Node.js** >= 22
- **pnpm** >= 10.23
- **PostgreSQL** with the [pgvector](https://github.com/pgvector/pgvector) extension
- **Docker** (optional, simplest way to run PostgreSQL)

### Initial Setup

```bash
# Clone and install
git clone <repo-url> && cd nomos
pnpm install

# Start PostgreSQL with pgvector
docker run -d \
  --name nomos-db \
  -e POSTGRES_USER=nomos \
  -e POSTGRES_PASSWORD=nomos \
  -e POSTGRES_DB=nomos \
  -p 5432:5432 \
  pgvector/pgvector:pg17

# Create .env with minimum config
cat > .env << 'EOF'
DATABASE_URL=postgresql://nomos:nomos@localhost:5432/nomos
ANTHROPIC_API_KEY=sk-ant-...
EOF

# Run database migrations
pnpm dev -- db migrate
```

Or skip the `.env` file entirely and run `pnpm dev` -- the setup wizard will open in your browser and walk you through everything.

### Running

```bash
pnpm dev                     # Run CLI via tsx (triggers setup wizard if needed)
pnpm dev -- chat             # Start interactive REPL
pnpm dev -- daemon run       # Run daemon in foreground (all channels + gRPC + WebSocket)
pnpm daemon:dev              # Shorthand for daemon run
```

### Settings Web UI

The settings UI is a separate Next.js 15 app in `settings/`:

```bash
cd settings && pnpm dev      # http://localhost:3456
```

Or from the CLI:

```bash
pnpm dev -- settings         # Starts settings dev server + opens browser
```

## Build & Quality

```bash
pnpm build                   # Build with tsdown -> dist/index.js
pnpm typecheck               # tsc --noEmit (main app only)
pnpm test                    # Vitest unit tests
pnpm test:watch              # Vitest watch mode
pnpm lint                    # oxlint
pnpm lint:fix                # oxlint --fix + oxfmt
pnpm format                  # oxfmt --write
pnpm format:check            # oxfmt --check
pnpm check                   # format:check + typecheck + lint (CI gate)
```

Run a single test:

```bash
npx vitest run src/path/to/file.test.ts
```

Tests are colocated with source as `*.test.ts`.

### Pre-commit Hooks

Husky + lint-staged runs on `git commit`:

- `oxfmt --write` on staged `.ts`/`.tsx` files
- `oxlint` on staged `.ts`/`.tsx` files

## Project Structure

### Two Applications

| Directory   | What            | Stack                                                                 |
| ----------- | --------------- | --------------------------------------------------------------------- |
| `/` (root)  | CLI + daemon    | TypeScript, Commander.js, Ink (React for CLI), Claude Agent SDK, gRPC |
| `settings/` | Settings web UI | Next.js 15, React 19, Tailwind CSS 4, lucide-react                    |

Each has its own `package.json`, `tsconfig.json`, and build pipeline. The root `pnpm typecheck` covers only the main app.

### Source Layout

```
src/
  index.ts                  Entry point: loads .env, delegates to Commander.js
  cli/                      CLI commands (chat, daemon, wizard, config, session, etc.)
  sdk/                      Claude Agent SDK wrapper + in-process MCP servers
  daemon/                   Daemon subsystem:
    gateway.ts                Orchestrator — boots all subsystems
    agent-runtime.ts          Centralized agent runtime (SDK session management)
    message-queue.ts          Per-session FIFO queue
    grpc-server.ts            gRPC server (primary protocol, port 8766)
    websocket-server.ts       WebSocket server (legacy, port 8765)
    channel-manager.ts        Adapter registry and lifecycle
    cron-engine.ts            DB-backed scheduled tasks
    memory-indexer.ts         Auto-indexes conversations into vector memory
    streaming-responder.ts    Progressive message updates for channels
    draft-manager.ts          Draft orchestration for Slack User Mode
    channels/                 Thin adapters: slack, discord, telegram, whatsapp, imessage
  config/                   Config loading:
    env.ts                    loadEnvConfig() sync + loadEnvConfigAsync() with DB merge
    profile.ts                User profile, agent identity, system prompt builder
    soul.ts                   SOUL.md personality file
    tools-md.ts               TOOLS.md environment config
    agents.ts                 Multi-agent configs from agents.json
  db/                       PostgreSQL persistence:
    client.ts                 Connection pool (postgres driver)
    schema.sql                Schema (idempotent migrations)
    migrate.ts                Migration runner
    config.ts                 Key-value config CRUD
    app-config.ts             App-level config CRUD (maps DB keys to NomosConfig fields)
    integrations.ts           Integration store with encrypted secrets
    encryption.ts             AES-256-GCM + auto-key generation
    sessions.ts, transcripts.ts, memory.ts, drafts.ts, slack-workspaces.ts
  memory/                   Vector memory: embeddings, chunking, hybrid search (RRF)
  ui/                       Terminal UI:
    repl.tsx                  Ink-based REPL with streaming markdown
    grpc-client.ts            gRPC client for daemon communication
    gateway-client.ts         WebSocket client (legacy)
    slash-commands.ts         30+ slash command handlers
  security/                 Tool approval policies
  sessions/                 Session scoping (channel, sender, peer, channel-peer)
  skills/                   Skill loader and frontmatter parser
  routing/                  Message routing rules

proto/
  nomos.proto               gRPC service definition (protobuf)

settings/
  src/app/                  Next.js pages:
    setup/                    5-step onboarding wizard
    dashboard/                Overview page (status, quick actions)
    settings/                 Assistant identity + API config
    integrations/             Channel config pages (slack, discord, telegram, google, whatsapp)
    admin/                    Advanced pages (database, memory)
    api/                      REST endpoints (env, config, status, setup, integrations)
  src/components/           Sidebar, integration cards, status badges, token inputs
  src/lib/                  DB client, env helpers, types

skills/                     25 bundled SKILL.md files
docs/                       Architecture docs and integration guides
```

## Architecture

### Config Architecture

Configuration loads with this precedence: **Database > env vars > defaults**.

```
┌─────────────┐    ┌──────────────┐    ┌──────────────┐
│  Setup       │    │  Settings    │    │  CLI         │
│  Wizard      │───>│  Web UI      │───>│  /config set │
└──────┬───────┘    └──────┬───────┘    └──────┬───────┘
       │                   │                   │
       v                   v                   v
┌──────────────────────────────────────────────────────┐
│  PostgreSQL                                          │
│  ┌──────────────┐  ┌────────────────────────────┐    │
│  │ config table │  │ integrations table          │    │
│  │ (key-value)  │  │ (encrypted secrets + config)│    │
│  └──────────────┘  └────────────────────────────┘    │
└──────────────────────────────────────────────────────┘
       │                                │
       v                                v
┌──────────────────────────────────────────────────────┐
│  loadEnvConfigAsync()                                │
│  DB values > process.env > hardcoded defaults        │
└──────────────────────────────────────────────────────┘
```

Key files:

- `src/config/env.ts` -- `loadEnvConfig()` (sync, env-only) and `loadEnvConfigAsync()` (DB + env merge)
- `src/db/app-config.ts` -- CRUD for DB-backed config (maps `app.model` -> `NomosConfig.model`, etc.)
- `src/db/integrations.ts` -- Encrypted integration secrets
- `src/db/encryption.ts` -- AES-256-GCM, auto-generates `~/.nomos/encryption.key` on first run

### Daemon Architecture

The daemon orchestrates everything:

```
Gateway (orchestrator)
  ├── AgentRuntime        Wraps Claude SDK, loads config once, processes messages
  ├── MessageQueue        Per-session FIFO (concurrent across sessions, serial within)
  ├── GrpcServer          gRPC on port 8766, server-side streaming for Chat RPC
  ├── WebSocketServer     Legacy WebSocket on port 8765
  ├── ChannelManager      Registers adapters based on configured integrations
  │     ├── SlackAdapter, SlackUserAdapter
  │     ├── DiscordAdapter
  │     ├── TelegramAdapter
  │     ├── WhatsAppAdapter
  │     └── IMessageAdapter
  ├── CronEngine          DB-backed scheduled tasks
  ├── DraftManager        Slack User Mode draft orchestration
  └── MemoryIndexer       Auto-indexes conversations (fire-and-forget)
```

### gRPC Protocol

Defined in `proto/nomos.proto`. Uses `@grpc/grpc-js` + `@grpc/proto-loader` (dynamic loading, no codegen step).

Key RPCs:

- `Chat` -- server-side streaming: send `ChatRequest`, receive stream of `AgentEvent`
- `Command` -- unary: execute slash commands
- `GetStatus` -- unary: health check
- `Ping/Pong` -- keepalive

The `.proto` file can generate native clients for iOS (Swift), Android (Kotlin), and other platforms.

## How-to Guides

### Adding a Channel Adapter

1. Create `src/daemon/channels/my-channel.ts` (~50-100 LOC)
2. Implement the `ChannelAdapter` interface from `src/daemon/channel-manager.ts`
3. Register it in `src/daemon/gateway.ts` -> `registerChannelAdapters()` behind an env var check
4. Add env var docs to `.env.example` and README
5. Create a settings page at `settings/src/app/integrations/my-channel/page.tsx`
6. Add the channel to the sidebar in `settings/src/components/sidebar.tsx`

### Adding a Config Key

1. Add the field to `NomosConfig` in `src/config/env.ts`
2. Add the env var fallback in `loadEnvConfig()`
3. Add the DB key mapping in `src/db/app-config.ts` -> `CONFIG_KEY_MAP`
4. If it's a secret, use `setAppSecrets()`/`getAppSecrets()` from `src/db/app-config.ts`

### Adding a Settings Page

1. Create `settings/src/app/<section>/page.tsx`
2. Create API routes at `settings/src/app/api/<section>/route.ts` if needed
3. Add nav entry in `settings/src/components/sidebar.tsx`
4. Use Catppuccin Mocha theme classes (`bg-base`, `bg-mantle`, `bg-surface0`, `text-text`, `text-mauve`, etc.)

### Adding a gRPC RPC

1. Add the RPC to `proto/nomos.proto`
2. Add the handler in `src/daemon/grpc-server.ts`
3. Add the client method in `src/ui/grpc-client.ts`

### Creating a Skill

Skills are `SKILL.md` files with YAML frontmatter:

```bash
mkdir -p skills/my-skill
```

```markdown
---
name: my-skill
description: "What this skill does"
emoji: "wrench"
requires:
  bins: [some-cli-tool]
install:
  - brew install some-cli-tool
---

# My Skill

Instructions for the agent...
```

Loaded from three tiers (highest priority first):

1. `./skills/` -- project-local
2. `~/.nomos/skills/` -- personal
3. `skills/` -- bundled

## Coding Conventions

### TypeScript

- Strict mode, ESM-only (`"type": "module"`)
- `.ts` extension imports: `import { foo } from "./bar.ts"`
- Avoid `any`; use `unknown` with type guards
- Keep files under ~500 lines

### Formatting & Linting

- **Oxfmt** (not Prettier) -- `pnpm format`
- **Oxlint** (not ESLint) -- `pnpm lint:fix`

### UI

- **Ink** (React) for terminal components
- **Next.js 15** + **React 19** for settings web UI
- **Catppuccin Mocha** palette everywhere
- **lucide-react** for icons in settings
- **chalk** for colors in non-Ink code

### Naming

- Files: `kebab-case.ts`
- Classes: `PascalCase`
- Functions/variables: `camelCase`
- Config keys in DB: `dot.separated` (e.g., `agent.name`, `app.model`)

### Database

- Schema in `src/db/schema.sql` -- idempotent (`CREATE TABLE IF NOT EXISTS`)
- Run `pnpm dev -- db migrate`
- Use `postgres` driver directly (no ORM)

## Submitting Changes

1. Create a branch from `main`
2. Make focused, well-described changes
3. Run `pnpm check && pnpm test`
4. Open a PR describing what changed and why

For larger changes, open an issue first to discuss the approach.

## Design Decisions (Don't "Fix" These)

- **Claude Code IS the runtime** -- don't reimplement the agent loop or tool execution
- **PostgreSQL only** -- no SQLite, no local file storage for data
- **Config in DB, .env as fallback** -- DB is source of truth for config set via UI/wizard
- **gRPC primary, WebSocket legacy** -- new client features use gRPC
- **Thin channel adapters** -- all agent logic centralized in `AgentRuntime`
- **Auto-generated encryption key** -- `~/.nomos/encryption.key` created on first run
- **In-process MCP** for memory/channel tools; external MCP from `.nomos/mcp.json`

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
