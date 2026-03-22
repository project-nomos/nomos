<p align="center">
  <img src="nomos-logo.svg" alt="Nomos" width="200" />
</p>

<h1 align="center">Nomos</h1>

<p align="center">
  An AI agent platform built on the Claude Agent SDK — persistent sessions, vector memory, multi-channel integrations, and a management dashboard, all in TypeScript.
</p>

---

## What is Nomos?

Nomos wraps Anthropic's [Claude Agent SDK](https://docs.anthropic.com/en/docs/claude-code/sdk) to inherit its full agent loop, built-in tools (Bash, Read, Write, Edit, Glob, Grep, WebSearch, etc.), streaming, and compaction. On top of that foundation, it adds persistent sessions, enterprise-grade vector memory, a daemon with 6 channel integrations, a web management dashboard, 25 bundled skills, multi-agent team orchestration, and smart model routing.

## Key Features

### Enterprise-Grade Vector Memory

Long-term memory powered by **pgvector** and hybrid RRF (Reciprocal Rank Fusion) retrieval. Every conversation turn is automatically chunked, embedded via Vertex AI (`gemini-embedding-001`, 768 dimensions), and indexed. Retrieval combines vector cosine similarity with PostgreSQL full-text search for high-quality recall across your entire conversation history.

### Adaptive Memory & User Model

When enabled (`NOMOS_ADAPTIVE_MEMORY=true`), the agent extracts structured knowledge from every conversation — facts, preferences, and corrections — using a lightweight LLM call (Haiku by default). Extracted knowledge is accumulated into a persistent **user model** that the agent uses to personalize responses across sessions.

- **Knowledge extraction** — facts about you, your projects, tech stack; preferences for coding style, communication, tools; corrections when you fix the agent's assumptions
- **User model accumulation** — repeated confirmations increase confidence; contradictions decrease it; high-confidence entries (≥0.6) are injected into the system prompt
- **Categorized memory** — memory chunks are tagged with categories (`fact`, `preference`, `correction`, `conversation`) for targeted recall via `memory_search`
- **`user_model_recall` tool** — the agent can proactively recall accumulated knowledge at the start of each conversation

### Multi-Client Architecture

Connect to Nomos through multiple interfaces simultaneously:

| Protocol           | Port | Purpose                                                 |
| ------------------ | ---- | ------------------------------------------------------- |
| **gRPC**           | 8766 | Primary protocol for CLI, web, and mobile clients       |
| **WebSocket**      | 8765 | Legacy protocol (maintained for backward compatibility) |
| **Ink CLI**        | —    | Interactive terminal REPL with streaming markdown       |
| **Next.js Web UI** | 3456 | Settings dashboard and management interface             |

### Web-Based Management Dashboard

A full Next.js 15 app at `settings/` provides a GUI for onboarding, assistant configuration, channel management, and advanced settings — no YAML editing required. Key pages include a setup wizard (`/setup`), dashboard overview, assistant identity configuration, per-channel integration management, and database/memory admin.

### Zero-Fork Extensibility

Extend Nomos without touching core code:

- **25 bundled skills** loaded from `skills/` with YAML frontmatter
- **Three-tier skill loading**: bundled → personal (`~/.nomos/skills/`) → project (`./skills/`)
- **MCP server support** via `.nomos/mcp.json` for external tool integrations
- **DB-stored configuration** — all settings persist in PostgreSQL, with env var fallback

### 6 Pre-Built Channel Integrations

| Platform     | Mode             | Transport                                                |
| ------------ | ---------------- | -------------------------------------------------------- |
| **Slack**    | Bot Mode         | Socket Mode                                              |
| **Slack**    | User Mode        | Socket Mode + OAuth (multi-workspace, draft-before-send) |
| **Discord**  | Bot              | Gateway                                                  |
| **Telegram** | Bot              | grammY                                                   |
| **WhatsApp** | Bridge           | Baileys                                                  |
| **iMessage** | Read-only bridge | macOS Messages.app SQLite                                |

Each adapter is a thin layer (~50–100 LOC). All agent logic is centralized in `AgentRuntime`; adapters just route messages in and responses out.

### Smart Model Routing

Automatically route queries to different Claude models based on complexity:

- **Simple** (greetings, short questions) → `claude-haiku-4-5` (fast, cheap)
- **Moderate** (general tasks) → `claude-sonnet-4-6` (balanced)
- **Complex** (coding, reasoning, multi-step) → `claude-opus-4-6` (most capable)

Enable with `NOMOS_SMART_ROUTING=true`. Configure per-tier models with `NOMOS_MODEL_SIMPLE`, `NOMOS_MODEL_MODERATE`, `NOMOS_MODEL_COMPLEX`.

### Encrypted Secrets at Rest

Integration secrets (API keys, OAuth tokens) are encrypted with **AES-256-GCM** before storage in PostgreSQL. An encryption key is auto-generated at `~/.nomos/encryption.key` on first run, or you can provide your own via the `ENCRYPTION_KEY` env var. No plaintext credentials in the database.

### Multi-Agent Teams

Decompose complex tasks across **parallel worker agents** for faster, more thorough results. A coordinator agent breaks down the task, spawns scoped workers via independent SDK sessions, collects their outputs with `Promise.allSettled()`, and synthesizes a unified response.

```
User prompt ──► Coordinator ──┬──► Worker 1 (subtask A) ──┐
                              ├──► Worker 2 (subtask B) ──┤──► Coordinator ──► Final response
                              └──► Worker 3 (subtask C) ──┘
```

- Workers run in **parallel** with independent SDK sessions and scoped prompts
- Each worker shares MCP servers and permissions with the main agent
- Failed workers are gracefully handled — other workers' results are preserved
- Trigger with `/team` prefix: `/team Research React vs Svelte and write a comparison`
- Configure via `NOMOS_TEAM_MODE=true` and `NOMOS_MAX_TEAM_WORKERS=3`
- Fully managed via the [Settings UI](#settings-web-ui) — no env editing required

---

## Additional Capabilities

- **Custom API endpoints** — point at Ollama, LiteLLM, or any Anthropic-compatible proxy via `ANTHROPIC_BASE_URL` (see [Custom API Endpoints](#custom-api-endpoints))
- **Slack User Mode** — act as the authenticated user: drafts responses to your DMs and @mentions for approval, then sends them as you
- **Cron / scheduled tasks** — run prompts on a schedule with configurable session targets and delivery modes
- **Automatic conversation memory** — every daemon conversation turn is indexed into vector memory, enabling cross-session and cross-channel recall
- **Session persistence** — all conversations stored in PostgreSQL with SDK session resume and auto-compaction
- **Personalization** — user profile, agent identity, SOUL.md personality, TOOLS.md environment config, per-agent configs
- **Web-based setup wizard** — guided 5-step onboarding (database, API provider, personality, channels, ready) with browser-based UI
- **Security** — tool execution approval for dangerous operations, configurable approval policies
- **Pairing system** — 8-character pairing codes with TTL for channel access control and DM policies
- **Conversation scoping** — per-sender, per-peer, per-channel, or per-channel-peer session isolation
- **Model switching** — pick between Opus, Sonnet, and Haiku mid-session; configurable thinking levels
- **Proactive messaging** — send outbound messages to any channel outside the reply flow

## Quick Start

### Install via Homebrew

```bash
brew tap project-nomos/nomos https://github.com/project-nomos/nomos
brew install project-nomos/nomos/nomos
```

### Install via npm (GitHub Packages)

```bash
npm install -g @project-nomos/nomos --registry=https://npm.pkg.github.com
```

### Install from source

```bash
git clone https://github.com/project-nomos/nomos.git
cd nomos
pnpm install
pnpm build
pnpm link --global
```

Then run:

```bash
nomos chat
```

The setup wizard opens in your browser and walks you through connecting a database, choosing an API provider, naming your assistant, and connecting channels. All config is saved to the database (encrypted).

For manual setup, see [Installation and Setup](#installation-and-setup) below.

## Prerequisites

- **Node.js** >= 22
- **PostgreSQL** with the [pgvector](https://github.com/pgvector/pgvector) extension
- **Anthropic API key** or **Google Cloud credentials** (for Vertex AI)
- **Google Cloud credentials** for embeddings (uses `gemini-embedding-001` via Vertex AI)

## Installation and Setup

### 1. Install dependencies

```bash
cd nomos
pnpm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` with your settings:

```bash
# --- Database (required) ---
DATABASE_URL=postgresql://nomos:nomos@localhost:5432/nomos

# --- Provider (choose one) ---

# Option A: Anthropic direct API
ANTHROPIC_API_KEY=sk-ant-...

# Option B: Vertex AI
CLAUDE_CODE_USE_VERTEX=1
GOOGLE_CLOUD_PROJECT=my-project
CLOUD_ML_REGION=us-east5

# --- Model ---
NOMOS_MODEL=claude-opus-4-6
```

### 3. Set up the database

PostgreSQL must have the [pgvector](https://github.com/pgvector/pgvector) extension installed.

#### Option A: Docker (recommended)

```bash
docker run -d \
  --name nomos-db \
  -e POSTGRES_USER=nomos \
  -e POSTGRES_PASSWORD=nomos \
  -e POSTGRES_DB=nomos \
  -p 5432:5432 \
  pgvector/pgvector:pg17
```

Set in `.env`:

```
DATABASE_URL=postgresql://nomos:nomos@localhost:5432/nomos
```

#### Option B: Local PostgreSQL (Homebrew)

```bash
brew install postgresql@17 pgvector
brew services start postgresql@17
createdb nomos
psql nomos -c "CREATE EXTENSION IF NOT EXISTS vector;"
```

### 4. Run migrations

```bash
pnpm dev -- db migrate
```

### 5. (Vertex AI only) Authenticate

If using Vertex AI for Claude and/or embeddings:

```bash
gcloud auth application-default login
```

## Usage

### Chat sessions

```bash
# Start an interactive chat
pnpm dev -- chat

# Specify a model
pnpm dev -- chat -m claude-sonnet-4-6

# Resume a previous session by key
pnpm dev -- chat -s my-project

# Force a fresh session (skip resume)
pnpm dev -- chat --fresh
```

### Production mode

```bash
pnpm build
node dist/index.js chat
```

### Daemon management

```bash
nomos daemon start              # Start daemon in background
nomos daemon start -p 9000      # Start on a custom port
nomos daemon stop               # Stop the running daemon
nomos daemon restart             # Restart the daemon
nomos daemon status              # Show daemon PID and status
nomos daemon logs                # Tail the last 50 lines of logs
nomos daemon logs -n 200         # Tail more lines
nomos daemon run                 # Run daemon in foreground (dev mode)
```

### Memory commands

```bash
# Index a single file into the vector store
pnpm dev -- memory add ./src/ui/repl.ts

# Index an entire directory recursively
pnpm dev -- memory add ./src

# Search the memory store
pnpm dev -- memory search "how does session persistence work"

# List indexed sources
pnpm dev -- memory list

# Clear all memory
pnpm dev -- memory clear
```

### Config commands

```bash
pnpm dev -- config list             # List all config values
pnpm dev -- config set <key> <val>  # Set a config value
pnpm dev -- config get <key>        # Get a config value
```

### Session management

```bash
pnpm dev -- session list            # List recent sessions
pnpm dev -- session archive <id>    # Archive a session
pnpm dev -- session delete <id>     # Delete a session
```

## Daemon Mode

The daemon is a long-running background process that turns Nomos into a multi-channel AI gateway. It boots an agent runtime, a gRPC server, a WebSocket server, channel adapters, and a cron engine -- then processes incoming messages from all sources through a per-session message queue.

### Architecture

```
                         +-------------------+
                         |     Gateway       |
                         | (orchestrator)    |
                         +--------+----------+
                                  |
      +------------+--------------+--------------+----------+
      |            |              |              |          |
+-----v------+ +--v-----+ +-----v--------+ +---v------+ +-v----------+
| gRPC       | | WS     | | Channel      | | Cron     | | Draft      |
| Server     | | Server | | Manager      | | Engine   | | Manager    |
| (port 8766)| | (8765) | | (adapters)   | |(schedule)| | (Slack UM) |
+-----+------+ +---+----+ +-----+--------+ +---+------+ +--+---------+
      |             |            |              |            |
      +------+------+------+----+------+-------+------+-----+
                            |
                   +--------v---------+
                   |  Message Queue   |
                   |  (per-session    |
                   |   FIFO)          |
                   +--------+---------+
                            |
                   +--------v---------+
                   |  Agent Runtime   |
                   |  (Claude SDK)    |
                   +------------------+
```

### How it works

1. **Gateway** boots all subsystems and installs signal handlers for graceful shutdown.
2. **Channel adapters** register automatically based on which environment variables are present (e.g., `SLACK_BOT_TOKEN` enables the Slack adapter).
3. **Message queue** serializes messages per session key -- concurrent messages to the same conversation are processed sequentially; messages for different sessions process in parallel.
4. **Agent runtime** loads config, profile, identity, skills, and MCP servers once at startup, then processes each message through the Claude Agent SDK.
5. **gRPC server** accepts connections from CLI, web, and mobile clients via server-side streaming. The WebSocket server runs alongside for backwards compatibility.

### Starting the daemon

```bash
# Background mode
nomos daemon start

# Development mode (foreground with logs)
nomos daemon run
```

The daemon writes a PID file to `~/.nomos/daemon.pid` and logs to `~/.nomos/daemon.log`.

## Channel Integrations

Each channel adapter is automatically registered when its required environment variables are present. No additional configuration is needed beyond setting the tokens. For detailed setup guides with screenshots and step-by-step instructions, see the [docs/integrations/](docs/integrations/) directory.

### Slack

Requires Socket Mode (for real-time events without a public URL).

```bash
SLACK_BOT_TOKEN=xoxb-...          # Bot User OAuth Token
SLACK_APP_TOKEN=xapp-...          # App-Level Token (Socket Mode)
SLACK_ALLOWED_CHANNELS=C123,C456  # Optional: restrict to specific channels
```

Responds to `@mentions` and direct messages. Supports threaded conversations with `thread_ts` routing.

#### Slack User Mode

User Mode lets Nomos act **as you** rather than as a bot. It listens to DMs and @mentions directed at your personal Slack account, generates draft responses, and waits for your approval before sending them with your user token.

```bash
SLACK_USER_TOKEN=xoxp-...          # User OAuth Token (in addition to bot tokens above)
```

When enabled, both adapters run simultaneously. Drafts can be approved via CLI (`/approve <id>`) or by clicking Approve/Reject buttons in a bot DM. See [docs/integrations/slack-user-mode.md](docs/integrations/slack-user-mode.md) for the full setup guide including required OAuth scopes and event subscriptions.

### Discord

```bash
DISCORD_BOT_TOKEN=...                     # Bot token from Discord Developer Portal
DISCORD_ALLOWED_CHANNELS=123456,789012    # Optional: restrict to specific channels
DISCORD_ALLOWED_GUILDS=111222             # Optional: restrict to specific servers
```

Responds to `@mentions` and DMs. Supports per-channel sessions and thread routing.

### Telegram

```bash
TELEGRAM_BOT_TOKEN=...                    # Token from @BotFather
TELEGRAM_ALLOWED_CHATS=123456,-789012     # Optional: restrict to specific chats
```

Uses grammY with long polling. Responds to all messages in private chats; requires `@mention` in group chats. Supports typing indicators and message chunking.

### WhatsApp

```bash
WHATSAPP_ENABLED=true
WHATSAPP_ALLOWED_CHATS=15551234567@s.whatsapp.net,120363123456789012@g.us
```

Uses the Baileys library with QR code authentication (no Meta Business API required). On first start, a QR code is displayed in the terminal for pairing. Auth state is persisted to `~/.nomos/whatsapp-auth/`.

## Multi-Agent Teams

Team mode decomposes complex tasks across parallel worker agents. A coordinator agent breaks down the task, spawns scoped workers via independent SDK sessions, and synthesizes their results into a single response.

### Enabling

```bash
NOMOS_TEAM_MODE=true
NOMOS_MAX_TEAM_WORKERS=3    # Maximum parallel workers (default: 3)
```

### Usage

Prefix your message with `/team` to trigger team orchestration:

```
/team Research the pros and cons of React vs Svelte and write a comparison document
```

### How it works

1. **Decomposition** — A coordinator agent analyzes the task and breaks it into independent subtasks (up to `maxWorkers`)
2. **Parallel execution** — Each subtask runs in its own SDK session with a scoped system prompt
3. **Synthesis** — The coordinator collects all worker outputs and produces a unified response

Workers share the same MCP servers and permissions as the main agent but operate in isolated sessions. If a worker fails, its error is reported in the synthesis step while other workers' results are preserved.

## Custom API Endpoints

Point Nomos at any Anthropic-compatible API proxy by setting `ANTHROPIC_BASE_URL`. This enables use with local model servers (via LiteLLM or similar proxies), alternative cloud providers, or corporate API gateways.

### Ollama + LiteLLM example

```bash
# 1. Start Ollama
ollama serve

# 2. Start LiteLLM as an Anthropic-compatible proxy
litellm --model ollama/llama3 --port 4000

# 3. Configure Nomos
ANTHROPIC_BASE_URL=http://localhost:4000
NOMOS_MODEL=claude-3-haiku   # or whatever model name the proxy expects
```

The base URL is propagated to all SDK sessions including team mode workers.

## Cron and Scheduled Tasks

The cron engine runs scheduled prompts through the agent runtime. Jobs are stored in the database and managed through the daemon.

### Schedule types

| Type    | Format               | Example                |
| ------- | -------------------- | ---------------------- |
| `at`    | ISO 8601 datetime    | `2025-06-15T09:00:00Z` |
| `every` | Interval string      | `30m`, `2h`, `1d`      |
| `cron`  | Standard cron syntax | `0 9 * * 1-5`          |

### Session targets

| Target     | Behavior                                    |
| ---------- | ------------------------------------------- |
| `main`     | Reuses a persistent session keyed by job ID |
| `isolated` | Creates a fresh session for each execution  |

### Delivery modes

| Mode       | Behavior                                 |
| ---------- | ---------------------------------------- |
| `none`     | Result is stored but not delivered       |
| `announce` | Result is sent to the configured channel |

Jobs track error counts and can be auto-disabled after repeated failures.

## Skills System

Skills are markdown files (`SKILL.md`) with YAML frontmatter that provide domain-specific instructions to the agent. Their content is injected into the system prompt at session start.

### Three-tier loading

Skills are loaded from three locations, in order:

1. **Bundled** -- `nomos/skills/` (shipped with the project)
2. **Personal** -- `~/.nomos/skills/<name>/SKILL.md`
3. **Project** -- `./skills/<name>/SKILL.md`

### Bundled skills

The following 25 skills are included:

| Skill                   | Description                         |
| ----------------------- | ----------------------------------- |
| `algorithmic-art`       | Generative art and creative coding  |
| `apple-notes`           | Apple Notes integration             |
| `apple-reminders`       | Apple Reminders integration         |
| `brand-guidelines`      | Brand and style guide creation      |
| `canvas-design`         | Canvas-based design generation      |
| `discord`               | Discord bot and integration help    |
| `doc-coauthoring`       | Collaborative document writing      |
| `docx`                  | Word document generation            |
| `frontend-design`       | Frontend UI/UX design guidance      |
| `github`                | GitHub workflow and PR management   |
| `google-workspace`      | Google Workspace integration (gws)  |
| `internal-comms`        | Internal communications drafting    |
| `mcp-builder`           | MCP server development              |
| `pdf`                   | PDF document generation             |
| `pptx`                  | PowerPoint presentation generation  |
| `skill-creator`         | Create new skills from prompts      |
| `slack`                 | Slack app and integration help      |
| `slack-gif-creator`     | Slack GIF creation                  |
| `telegram`              | Telegram bot and integration help   |
| `theme-factory`         | Theme and color scheme generation   |
| `weather`               | Weather information and forecasts   |
| `web-artifacts-builder` | Web artifact (HTML/CSS/JS) creation |
| `webapp-testing`        | Web application testing guidance    |
| `whatsapp`              | WhatsApp integration help           |
| `xlsx`                  | Excel spreadsheet generation        |

### Creating a custom skill

```bash
mkdir -p ~/.nomos/skills/my-skill
cat > ~/.nomos/skills/my-skill/SKILL.md << 'EOF'
---
name: my-skill
description: "What this skill does"
emoji: "🔧"
requires:
  bins: [jq]
  os: [darwin, linux]
install:
  - brew install jq
---

# My Skill

Instructions for the agent when this skill is active...
EOF
```

Skills support metadata fields for `requires` (binary and OS dependencies), `install` (installation commands), and `emoji` (display icon).

### Skill creator

The bundled `skill-creator` skill enables the agent to create new skills on your behalf via conversation. Ask the agent to create a skill and it will generate the SKILL.md file with proper frontmatter.

## Memory System

The memory system uses PostgreSQL with pgvector for hybrid retrieval that combines vector similarity search with full-text search, fused using Reciprocal Rank Fusion (RRF).

### How it works

- **Embeddings** are generated using Google's `gemini-embedding-001` model (768 dimensions) through Vertex AI
- **Chunking** splits documents into overlapping text segments for indexing
- **Hybrid search** runs both vector cosine similarity and PostgreSQL full-text search, then merges results with RRF scoring
- **FTS fallback** is used when embedding generation is unavailable
- **Automatic conversation indexing** -- every daemon conversation turn is automatically chunked, embedded, and stored in memory, enabling cross-session and cross-channel recall

### Automatic conversation indexing

When the daemon processes a message, the user's input and the agent's response are automatically indexed into the memory store after delivery. This runs asynchronously (fire-and-forget) so it never delays message delivery.

- Stored with source `"conversation"` and path set to the session key (e.g., `slack:C01ABC123`)
- Works across all channels -- Slack, Discord, Telegram, WhatsApp, and CLI via WebSocket
- Falls back to text-only indexing (full-text search) when embeddings are unavailable
- `nomos memory list` shows conversation memory alongside manually indexed files
- `nomos memory clear -s conversation` clears only conversation memory

### Adaptive memory

When `NOMOS_ADAPTIVE_MEMORY=true`, an additional post-processing step runs after each conversation is indexed:

1. **Knowledge extraction** — a lightweight LLM call (Haiku by default) extracts facts, preferences, and corrections from the conversation turn
2. **Categorized storage** — extracted items are stored as separate memory chunks with `metadata.category` tags (`fact`, `preference`, `correction`)
3. **User model accumulation** — extracted knowledge is aggregated into the `user_model` table with confidence scores. Repeated confirmations increase confidence; contradictions decrease it
4. **Prompt injection** — high-confidence user model entries (≥0.6) are injected into the system prompt as a "What I Know About You" section

This runs fire-and-forget and only triggers when the user message is >50 characters (skipping greetings and short commands).

### Agent integration

The agent has access to two MCP tools for memory:

- **`memory_search`** — hybrid vector + full-text search over `memory_chunks`. Supports an optional `category` filter (`fact`, `preference`, `correction`, `skill`, `conversation`) for targeted recall.
- **`user_model_recall`** — reads accumulated knowledge about the user from the `user_model` table. Supports optional category filtering (`preference`, `fact`, `style`).

At the start of each session, the agent proactively uses `user_model_recall` to load context about the user. Automatically indexed conversations appear in search results, enabling the agent to recall past interactions regardless of which channel or session they occurred in.

### CLI commands

```bash
pnpm dev -- memory add ./path/to/file      # Index a file
pnpm dev -- memory add ./path/to/directory  # Index a directory recursively
pnpm dev -- memory search "query text"      # Search the store
pnpm dev -- memory list                     # List indexed sources
pnpm dev -- memory clear                    # Clear all memory
pnpm dev -- memory clear -s conversation    # Clear only conversation memory
```

## Personalization

### User profile

Set your profile to receive personalized responses. Profile values are stored in the database config table and appended to the system prompt.

```bash
# Inside the REPL:
/profile set name Alice
/profile set timezone America/New_York
/profile set workspace "Building a React dashboard"
/profile set instructions "Always respond concisely"
```

### Agent identity

Customize how the agent presents itself:

```bash
/identity set name Jarvis
/identity set emoji 🤖
```

### SOUL.md

A personality file that shapes the agent's tone and behavior. Place it at:

- `./.nomos/SOUL.md` (project-local, takes priority)
- `~/.nomos/SOUL.md` (global)

The content is injected into the system prompt under a "Personality" section.

### TOOLS.md

An environment configuration file that tells the agent about available tools and environment details. Same search paths as SOUL.md:

- `./.nomos/TOOLS.md` (project-local)
- `~/.nomos/TOOLS.md` (global)

### Per-agent configs

Define multiple agent personalities in `agents.json`. Switch between them with `/agent <id>` in the REPL. Each agent can have its own model, thinking level, and system prompt instructions.

### First-run bootstrap

On first launch, if no `.env` file exists, an interactive setup wizard walks through:

1. Database connection (DATABASE_URL)
2. API provider selection (Anthropic direct or Vertex AI)
3. API key or Google Cloud project configuration
4. Model selection

## Slash Commands

All commands are available inside the REPL during a chat session.

### Session

| Command       | Description                                      |
| ------------- | ------------------------------------------------ |
| `/clear`      | Clear conversation context                       |
| `/compact`    | Compact conversation to reduce context usage     |
| `/status`     | Show system status overview (model, usage, etc.) |
| `/context`    | Show context usage estimate                      |
| `/cost`       | Show session token usage                         |
| `/history`    | Show conversation message summary                |
| `/undo`       | Remove the last exchange                         |
| `/undo-files` | Revert file changes (placeholder for V2 SDK)     |
| `/session`    | Show current session info                        |

### Model

| Command                 | Description                                     |
| ----------------------- | ----------------------------------------------- |
| `/model`                | Show current model and available options        |
| `/model <name\|number>` | Switch model by name or picker number           |
| `/thinking`             | Show/set thinking level                         |
| `/thinking <level>`     | Set level: off, minimal, low, medium, high, max |
| `/think-hard`           | Alias for `/thinking low`                       |
| `/ultrathink`           | Alias for `/thinking high`                      |
| `/sandbox`              | Show/toggle sandbox mode (on/off)               |

### Profile

| Command                       | Description                                                 |
| ----------------------------- | ----------------------------------------------------------- |
| `/profile`                    | View user profile                                           |
| `/profile set <key> <value>`  | Set profile field (name, timezone, workspace, instructions) |
| `/identity`                   | View agent identity                                         |
| `/identity set <key> <value>` | Set identity field (name, emoji)                            |
| `/skills`                     | List loaded skills                                          |
| `/skills info <name>`         | Show skill details and content                              |
| `/agent`                      | List agent configs                                          |
| `/agent <id>`                 | Switch active agent                                         |

### Drafts (Slack User Mode)

| Command         | Description                                        |
| --------------- | -------------------------------------------------- |
| `/drafts`       | List pending draft responses                       |
| `/approve <id>` | Approve a draft and send as the authenticated user |
| `/reject <id>`  | Reject a draft response                            |

Short IDs (first 8 characters of the UUID) are used for convenience. The commands match by prefix.

### Config

| Command                     | Description                  |
| --------------------------- | ---------------------------- |
| `/config set <key> <value>` | Change a setting             |
| `/tools`                    | List available tools         |
| `/mcp`                      | List MCP servers             |
| `/memory search <query>`    | Search the vector memory     |
| `/memory add <file>`        | Add a file to memory         |
| `/integrations`             | Setup channel integrations   |
| `/integrations <name>`      | Setup a specific integration |

### Exit

| Command              | Description |
| -------------------- | ----------- |
| `/quit` `/exit` `/q` | Exit Nomos  |

## MCP Servers

Add external MCP servers by creating `.nomos/mcp.json` in your project or home directory:

```json
{
  "mcpServers": {
    "my-server": {
      "command": "node",
      "args": ["./path/to/mcp-server.js"]
    },
    "remote-server": {
      "type": "sse",
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

These are passed directly to the Claude Agent SDK alongside the built-in `nomos-memory` MCP server, which exposes the `memory_search` and `user_model_recall` tools.

## gRPC Protocol

When the daemon is running, clients communicate via gRPC on `localhost:8766` (port is WebSocket port + 1). The service is defined in [`proto/nomos.proto`](proto/nomos.proto).

### Service definition

```protobuf
service NomosAgent {
  rpc Chat (ChatRequest) returns (stream AgentEvent);    // Streaming chat
  rpc Command (CommandRequest) returns (CommandResponse); // Slash commands
  rpc GetStatus (Empty) returns (StatusResponse);         // Health check
  rpc ListSessions (Empty) returns (SessionList);         // Session management
  rpc GetSession (SessionRequest) returns (SessionResponse);
  rpc ListDrafts (Empty) returns (DraftList);             // Draft management
  rpc ApproveDraft (DraftAction) returns (DraftResponse);
  rpc RejectDraft (DraftAction) returns (DraftResponse);
  rpc Ping (Empty) returns (PongResponse);                // Keepalive
}
```

The `Chat` RPC uses server-side streaming -- the client sends a single `ChatRequest` and receives a stream of `AgentEvent` messages. Each event has a `type` field and a `json_payload` containing the event data (same structure as the WebSocket protocol below).

The `.proto` file can generate native clients for iOS (Swift), Android (Kotlin), and other platforms.

## WebSocket Protocol (Legacy)

The WebSocket server runs on `ws://localhost:8765` alongside the gRPC server for backwards compatibility.

### Client messages (client to server)

```typescript
// Send a user message
{ type: "message", content: "Hello", sessionKey: "my-session" }

// Run a slash command
{ type: "command", command: "/status", sessionKey: "my-session" }

// Approve a pending draft (Slack User Mode)
{ type: "approve_draft", draftId: "uuid-string" }

// Reject a pending draft (Slack User Mode)
{ type: "reject_draft", draftId: "uuid-string" }

// Keep-alive ping
{ type: "ping" }
```

### Server events (server to client)

```typescript
// Streamed SDK events (text chunks, tool use, thinking, etc.)
{ type: "stream_event", event: SDKMessage }

// Tool execution summary
{ type: "tool_use_summary", tool_name: "Bash", summary: "Running tests" }

// Final result with usage stats
{ type: "result", result: [...], usage: { input_tokens: 1234, output_tokens: 567 }, total_cost_usd: 0.05, session_id: "..." }

// System notifications (including draft events: draft_created, draft_approved, draft_rejected)
{ type: "system", subtype: "info", message: "Session resumed", data: {} }

// Error messages
{ type: "error", message: "Something went wrong" }

// Pong response to ping
{ type: "pong" }
```

The server maintains heartbeat checks every 30 seconds and terminates unresponsive connections.

## Development

```bash
pnpm dev                # Run in dev mode (tsx, no build needed)
pnpm build              # Build with tsdown -> dist/index.js
pnpm typecheck          # TypeScript type check (tsc --noEmit)
pnpm test               # Run tests (vitest)
pnpm test:watch         # Tests in watch mode
pnpm lint               # Lint (oxlint)
pnpm lint:fix           # Lint fix + format
pnpm format             # Format (oxfmt)
pnpm format:check       # Check formatting
pnpm check              # Full check (format + typecheck + lint)
pnpm daemon:dev         # Run daemon in dev mode (tsx)
```

## Architecture

```
User input --> REPL (src/ui/repl.ts)
  --> SDK query() with model, permissions, system prompt
  --> MCP servers: external (from mcp.json) + in-process (memory_search)
  --> Iterate SDK messages --> render to terminal + persist to PostgreSQL

Daemon mode:
  Channel message --> Channel Adapter --> Message Queue
    --> Agent Runtime (SDK query) --> Response --> Channel Adapter --> Platform
```

### Source structure

```
src/
  index.ts                    # CLI entry point
  sdk/
    session.ts                # Wraps Claude Agent SDK query()
    tools.ts                  # In-process MCP server (memory_search, user_model_recall)
    google-workspace-mcp.ts   # Google Workspace MCP via @googleworkspace/cli (gws)
  cli/
    program.ts                # Commander.js setup
    chat.ts                   # Chat command: wires SDK + MCP + REPL
    daemon.ts                 # Daemon lifecycle commands (start/stop/restart/status/logs/run)
    wizard.ts                 # First-run setup wizard
    config.ts                 # Config CLI commands
    session.ts                # Session CLI commands
    db.ts                     # DB migration CLI
    memory.ts                 # Memory CLI commands
    mcp-config.ts             # MCP config file loader
    send.ts                   # Proactive message sending CLI
  config/
    env.ts                    # Environment variable resolution
    profile.ts                # User profile, agent identity, system prompt builder
    soul.ts                   # SOUL.md personality file loader
    tools-md.ts               # TOOLS.md environment config loader
    agents.ts                 # Per-agent config system (agents.json)
  daemon/
    gateway.ts                # Main daemon orchestrator
    agent-runtime.ts          # Centralized agent runtime (SDK session management)
    message-queue.ts          # Per-session FIFO queue with serialized processing
    websocket-server.ts       # WebSocket server (legacy, kept for compatibility)
    grpc-server.ts            # gRPC server for CLI, web, and mobile clients
    channel-manager.ts        # Channel adapter registry and lifecycle
    cron-engine.ts            # Cron scheduler wired to message queue
    lifecycle.ts              # PID file, signal handlers, process management
    memory-indexer.ts         # Automatic conversation memory indexing
    streaming-responder.ts    # Progressive message updates for channels
    index.ts                  # Daemon entry point
    types.ts                  # Shared types (messages, events, protocol)
    draft-manager.ts          # Draft orchestration for Slack User Mode
    team-runtime.ts           # Multi-agent team orchestration
    channels/
      slack.ts                # Slack adapter (@slack/bolt, Socket Mode)
      slack-user.ts           # Slack User Mode adapter (acts as authenticated user)
      discord.ts              # Discord adapter (discord.js)
      telegram.ts             # Telegram adapter (grammY)
      whatsapp.ts             # WhatsApp adapter (Baileys)
  auto-reply/
    heartbeat.ts              # Agent heartbeat and auto-reply logic
  cron/
    types.ts                  # Schedule types, session targets, delivery modes
  db/
    client.ts                 # PostgreSQL connection pool
    migrate.ts                # Schema and migrations
    schema.sql                # Database schema
    sessions.ts               # Session CRUD
    transcripts.ts            # Transcript CRUD
    memory.ts                 # Memory chunk CRUD (vector + FTS + category filtering)
    user-model.ts             # User model CRUD (accumulated preferences/facts)
    config.ts                 # Key-value config store
    app-config.ts             # App-level config CRUD (DB-backed NomosConfig)
    integrations.ts           # Unified integration store with encrypted secrets
    encryption.ts             # AES-256-GCM encryption for secrets at rest
    drafts.ts                 # Draft message CRUD (Slack User Mode)
  memory/
    embeddings.ts             # Vertex AI gemini-embedding-001 (768 dims)
    chunker.ts                # Text chunking with overlap
    search.ts                 # Hybrid search (RRF: vector + full-text)
    extractor.ts              # Knowledge extraction from conversations via LLM
    user-model.ts             # User model aggregation logic
  routing/
    router.ts                 # Message routing between channels
    store.ts                  # Route configuration store
    types.ts                  # Routing type definitions
  sessions/
    identity.ts               # Session identity resolution
    store.ts                  # Session store
    types.ts                  # Session scope modes
  security/
    tool-approval.ts          # Dangerous tool detection and approval policies
  skills/
    types.ts                  # Skill type definitions
    frontmatter.ts            # YAML frontmatter parser
    loader.ts                 # Skill loading + prompt formatting
  ui/
    repl.ts                   # REPL loop, SDK message rendering
    grpc-client.ts            # gRPC client for daemon communication
    gateway-client.ts         # WebSocket client (legacy)
    slash-commands.ts         # Slash command dispatch and handlers
    banner.ts                 # Startup banner with random taglines
proto/
  nomos.proto                 # gRPC service definition (protobuf)
skills/                       # Bundled skills (25 SKILL.md files)
docs/integrations/            # Detailed channel setup guides
```

## Configuration Reference

Configuration is loaded with the following precedence: **Database > environment variables > hardcoded defaults**. The setup wizard and settings UI write to the database. Environment variables in `.env` still work as a fallback.

API keys and secrets are stored encrypted (AES-256-GCM) in the `integrations` table. An encryption key is auto-generated at `~/.nomos/encryption.key` on first run, or you can set `ENCRYPTION_KEY` manually.

### Required

| Variable       | Description                                       | Default |
| -------------- | ------------------------------------------------- | ------- |
| `DATABASE_URL` | PostgreSQL connection string (must have pgvector) | --      |

### Provider (set one)

| Variable                 | Description                             | Default |
| ------------------------ | --------------------------------------- | ------- |
| `ANTHROPIC_API_KEY`      | Anthropic direct API key                | --      |
| `CLAUDE_CODE_USE_VERTEX` | Set to `1` to use Vertex AI             | --      |
| `GOOGLE_CLOUD_PROJECT`   | Google Cloud project ID (for Vertex AI) | --      |
| `CLOUD_ML_REGION`        | Vertex AI region for Claude             | --      |

### Model and behavior

| Variable                 | Description                                                                   | Default             |
| ------------------------ | ----------------------------------------------------------------------------- | ------------------- |
| `NOMOS_MODEL`            | Default Claude model                                                          | `claude-sonnet-4-6` |
| `NOMOS_PERMISSION_MODE`  | Tool permission mode (default, acceptEdits, plan, dontAsk, bypassPermissions) | `acceptEdits`       |
| `NOMOS_BETAS`            | SDK betas to enable (comma-separated)                                         | --                  |
| `NOMOS_FALLBACK_MODELS`  | Fallback model chain (comma-separated)                                        | --                  |
| `NOMOS_USE_V2_SDK`       | Opt in to V2 SDK session API                                                  | `false`             |
| `NOMOS_SESSION_SCOPE`    | Session scope mode (channel, sender, peer, channel-peer)                      | `channel`           |
| `TOOL_APPROVAL_POLICY`   | Dangerous tool policy (always_ask, warn_only, block_critical, disabled)       | `block_critical`    |
| `NOMOS_TEAM_MODE`        | Enable multi-agent team orchestration                                         | `false`             |
| `NOMOS_MAX_TEAM_WORKERS` | Max parallel workers in team mode                                             | `3`                 |
| `ANTHROPIC_BASE_URL`     | Custom Anthropic API base URL (Ollama, LiteLLM, etc.)                         | —                   |
| `NOMOS_ADAPTIVE_MEMORY`  | Enable knowledge extraction and user model learning                           | `false`             |
| `NOMOS_EXTRACTION_MODEL` | Model for knowledge extraction                                                | `claude-haiku-4-5`  |

### Embeddings

| Variable             | Description                       | Default                |
| -------------------- | --------------------------------- | ---------------------- |
| `EMBEDDING_MODEL`    | Embedding model for memory        | `gemini-embedding-001` |
| `VERTEX_AI_LOCATION` | Vertex AI location for embeddings | `global`               |

### Daemon

| Variable                | Description                             | Default            |
| ----------------------- | --------------------------------------- | ------------------ |
| `DAEMON_PORT`           | WebSocket port (gRPC runs on port + 1)  | `8765`             |
| `HEARTBEAT_INTERVAL_MS` | Agent heartbeat interval (0 to disable) | `1800000` (30 min) |

### Channel integrations

| Variable                   | Description                                    | Default |
| -------------------------- | ---------------------------------------------- | ------- |
| `SLACK_BOT_TOKEN`          | Slack Bot User OAuth Token                     | --      |
| `SLACK_APP_TOKEN`          | Slack App-Level Token (Socket Mode)            | --      |
| `SLACK_ALLOWED_CHANNELS`   | Comma-separated Slack channel IDs              | --      |
| `SLACK_USER_TOKEN`         | Slack User OAuth Token for User Mode (`xoxp-`) | --      |
| `DISCORD_BOT_TOKEN`        | Discord bot token                              | --      |
| `DISCORD_ALLOWED_CHANNELS` | Comma-separated Discord channel IDs            | --      |
| `DISCORD_ALLOWED_GUILDS`   | Comma-separated Discord guild IDs              | --      |
| `TELEGRAM_BOT_TOKEN`       | Telegram bot token from @BotFather             | --      |
| `TELEGRAM_ALLOWED_CHATS`   | Comma-separated Telegram chat IDs              | --      |
| `WHATSAPP_ENABLED`         | Set to `true` to enable WhatsApp               | --      |
| `WHATSAPP_ALLOWED_CHATS`   | Comma-separated WhatsApp JIDs                  | --      |

### Pairing and access control

| Variable              | Description                          | Default                        |
| --------------------- | ------------------------------------ | ------------------------------ |
| `PAIRING_TTL_MINUTES` | Pairing code expiry time             | `60`                           |
| `DEFAULT_DM_POLICY`   | DM policy (pairing, allowlist, open) | `open` (dev), `pairing` (prod) |

## Settings Web UI

A local Next.js app at `settings/` for managing your assistant via the browser (port 3456). See [docs/settings-ui.md](docs/settings-ui.md) for the full architecture.

### Pages

| Route                    | Description                                                                     |
| ------------------------ | ------------------------------------------------------------------------------- |
| `/`                      | Auto-redirect: `/setup` if onboarding incomplete, `/dashboard` otherwise        |
| `/setup`                 | 5-step onboarding wizard (database, API, personality, channels, ready)          |
| `/dashboard`             | Overview: assistant status, model, active channels, memory stats, quick actions |
| `/settings`              | Assistant identity (name, emoji, purpose), API config, model, advanced settings |
| `/integrations`          | Channel overview cards                                                          |
| `/integrations/slack`    | Slack workspace management                                                      |
| `/integrations/discord`  | Discord bot configuration                                                       |
| `/integrations/telegram` | Telegram bot configuration                                                      |
| `/integrations/google`   | Google Workspace OAuth + service selection                                      |
| `/integrations/whatsapp` | WhatsApp configuration                                                          |
| `/admin/database`        | Database connection and migration status                                        |
| `/admin/memory`          | Memory store stats and management                                               |

### Running the Settings UI

```bash
nomos settings              # Start on http://localhost:3456 and open browser
nomos settings --port 4000  # Custom port
```

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, testing, code conventions, and how to submit pull requests.

## License

[MIT](LICENSE)
