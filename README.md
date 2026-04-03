<p align="center">
  <img src="images/project-nomos-header.png" alt="Project Nomos" width="100%" />
</p>

<p align="center">
  <strong>An autonomous AI agent that remembers everything, works everywhere, and never stops learning</strong><br/>
  Deploy to Slack, Discord, Telegram, WhatsApp — with persistent memory, multi-agent teams, and a web dashboard. All TypeScript, fully open source.
</p>

<p align="center">
  <a href="#get-running-in-2-minutes">Quick Start</a> &middot;
  <a href="#what-you-get">Features</a> &middot;
  <a href="#advanced-agent-capabilities">Advanced</a> &middot;
  <a href="#daemon-mode">Daemon</a> &middot;
  <a href="#channel-integrations">Channels</a> &middot;
  <a href="#skills-system">Skills</a> &middot;
  <a href="#contributing">Contributing</a>
</p>

<p align="center">
  <a href="https://github.com/project-nomos/nomos/releases"><img src="https://img.shields.io/github/v/release/project-nomos/nomos" alt="Release" /></a>
  <a href="https://github.com/project-nomos/nomos/actions/workflows/ci.yml"><img src="https://github.com/project-nomos/nomos/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://github.com/project-nomos/nomos/actions/workflows/docker.yml"><img src="https://github.com/project-nomos/nomos/actions/workflows/docker.yml/badge.svg" alt="Docker" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License" /></a>
  <img src="https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg" alt="Node >= 22" />
  <img src="https://img.shields.io/badge/TypeScript-strict-blue.svg" alt="TypeScript Strict" />
  <img src="https://img.shields.io/badge/Claude_Agent_SDK-powered-6B4FBB?logo=anthropic" alt="Claude Agent SDK" />
  <img src="https://img.shields.io/badge/AI-agent_teams-ff6f00" alt="Agent Teams" />
  <img src="https://img.shields.io/badge/RAG-vector_memory-00b4d8" alt="Vector Memory" />
  <img src="https://img.shields.io/badge/skills-35+-10b981" alt="35+ Skills" />
  <img src="https://img.shields.io/badge/MCP-compatible-10b981?logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxNiIgaGVpZ2h0PSIxNiIgZmlsbD0id2hpdGUiIHZpZXdCb3g9IjAgMCAxNiAxNiI+PGNpcmNsZSBjeD0iOCIgY3k9IjgiIHI9IjMiLz48L3N2Zz4=" alt="MCP Compatible" />
  <img src="https://img.shields.io/badge/pnpm-10.23+-yellow.svg" alt="pnpm" />
  <a href="https://github.com/project-nomos/nomos/pkgs/container/nomos"><img src="https://img.shields.io/badge/GHCR-container-blue?logo=docker" alt="Docker Image" /></a>
  <a href="https://github.com/project-nomos/nomos/stargazers"><img src="https://img.shields.io/github/stars/project-nomos/nomos?style=flat" alt="Stars" /></a>
</p>

---

## What is Nomos?

Most AI assistants forget you the moment a conversation ends. Nomos doesn't.

Nomos is an autonomous AI agent platform that **remembers every interaction**, connects to your tools and channels, and gets smarter over time. It runs as a persistent background daemon — always on, always learning — reachable from Slack, Discord, Telegram, WhatsApp, the terminal, or any gRPC/WebSocket client.

It comes with **persistent vector memory** across sessions and channels, **multi-agent team orchestration** for complex tasks, **smart model routing** to optimize cost and quality, **60+ bundled skills**, a **web management dashboard**, built-in **image and video generation**, **event-driven hooks**, **cost tracking**, **context visualization**, **background memory consolidation**, and **self-updating documentation**.

> **What powers Nomos?** Under the hood, Nomos is built on Anthropic's [Claude Agent SDK](https://docs.anthropic.com/en/docs/claude-code/sdk) — inheriting the full agent loop, built-in tools, streaming, and compaction. Nomos adds the infrastructure layer on top: memory, channels, teams, scheduling, and a management UI.

---

## Get Running in 2 Minutes

```bash
# Homebrew (recommended)
brew tap project-nomos/nomos https://github.com/project-nomos/nomos
brew install project-nomos/nomos/nomos

# Then just:
nomos chat
```

That's it. A browser-based setup wizard handles the rest — database connection, API provider, assistant personality, and channel integrations. Everything is saved encrypted in PostgreSQL. Configuration is stored in `~/.nomos/.env` and works from any directory.

<details>
<summary><strong>Other installation methods</strong></summary>

### npm (GitHub Packages)

```bash
npm install -g @project-nomos/nomos --registry=https://npm.pkg.github.com
```

### Docker Compose (includes database)

```bash
git clone https://github.com/project-nomos/nomos.git
cd nomos
cp .env.example .env
# Edit .env with your ANTHROPIC_API_KEY (or OPENROUTER_API_KEY)
docker compose up -d
```

The agent is accessible via gRPC on port 8766 and WebSocket on port 8765.

### Docker (standalone)

```bash
docker run -d --name nomos \
  -e DATABASE_URL=postgresql://nomos:nomos@host.docker.internal:5432/nomos \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  -p 8766:8766 -p 8765:8765 \
  ghcr.io/project-nomos/nomos:latest
```

### From source

```bash
git clone https://github.com/project-nomos/nomos.git
cd nomos
pnpm install
pnpm build
pnpm link --global
nomos chat
```

</details>

### Prerequisites

- **Node.js** >= 22
- **PostgreSQL** with the [pgvector](https://github.com/pgvector/pgvector) extension
- **One of**: Anthropic API key, Google Cloud credentials (Vertex AI), [OpenRouter](https://openrouter.ai) API key, or a local [Ollama](https://ollama.com) instance
- **Google Cloud credentials** for embeddings (optional — falls back to full-text search when unavailable)

---

## What You Get

|                           | Feature                                                                            | What it does                                                                                 |
| ------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| :brain:                   | [**Memory That Persists**](#memory-that-persists-across-sessions-and-channels)     | Every conversation auto-indexed into pgvector. Recall anything from any session or channel.  |
| :speech_balloon:          | [**6 Channel Integrations**](#deploy-to-6-platforms-in-minutes)                    | Slack, Discord, Telegram, WhatsApp, iMessage — thin adapters, one agent runtime.             |
| :busts_in_silhouette:     | [**Multi-Agent Teams**](#multi-agent-teams--parallelize-complex-work)              | Coordinator + parallel workers. Hand off complex tasks, get synthesized results.             |
| :zap:                     | [**Smart Model Routing**](#smart-model-routing--cut-costs-without-cutting-quality) | Route by complexity across any provider — cloud, local, or hybrid. Cut costs automatically.  |
| :globe_with_meridians:    | [**Multiple API Providers**](#multiple-api-providers)                              | 5 providers supported: direct API, Vertex AI, OpenRouter, Ollama, or custom.                 |
| :art:                     | [**Image & Video Gen**](#image--video-generation--built-in-not-bolted-on)          | Gemini image + Veo video generation, conversational — just ask.                              |
| :desktop_computer:        | [**Web Dashboard**](#web-based-management-dashboard)                               | Next.js 16 settings UI with setup wizard. No YAML editing.                                   |
| :jigsaw:                  | [**27 Bundled Skills**](#extend-without-forking)                                   | Three-tier loading: bundled, personal, project. Create your own in minutes.                  |
| :lock:                    | [**Secrets Encrypted at Rest**](#secrets-encrypted-at-rest)                        | AES-256-GCM for all API keys and tokens. Auto-key on first run.                              |
| :brain:                   | [**Adaptive Memory**](#adaptive-memory--user-model)                                | Extracts facts, preferences, corrections. Builds a persistent user model.                    |
| :arrows_counterclockwise: | [**Self-Improvement**](#self-improvement--an-agent-that-evolves-itself)            | Nomos can analyze its own code, implement fixes, and open PRs to itself.                     |
| :globe_with_meridians:    | [**Browser Automation**](#interactive-browser-automation)                          | Playwright-based interactive browser with persistent sessions across tool calls.             |
| :gear:                    | [**Task Management**](#task-state-machine--dependency-graph)                       | Task lifecycle tracking with dependency graphs, auto-unblock, and cancellation.              |
| :mag:                     | [**LSP Code Intelligence**](#lsp-code-intelligence)                                | Go-to-definition, find-references, hover, document symbols via TypeScript LSP.               |
| :sleeping:                | [**Sleep & Self-Resume**](#sleep--self-resume)                                     | Agents pause and wake with a prompt — for polling, monitoring, and async waits.              |
| :clipboard:               | [**Plan Mode**](#plan-mode)                                                        | Agent proposes structured plans for review before making changes.                            |
| :moneybag:                | [**Cost Tracking**](#cost-tracking)                                                | Per-model pricing, session cost summaries, and usage breakdown in CLI and web dashboard.     |
| :anchor:                  | [**Event Hooks**](#event-hooks)                                                    | Extend the agent with command, HTTP, or prompt hooks on tool use, lifecycle, and compaction. |
| :bar_chart:               | [**Context Visualization**](#context-visualization)                                | See how your context window is used — system prompt, conversation, tools, memory, skills.    |
| :shield:                  | [**Bash Safety Analysis**](#bash-safety-analysis)                                  | Detects destructive commands, elevated privileges, and dangerous git ops before execution.   |
| :crescent_moon:           | [**Auto-Dream Memory**](#auto-dream-memory-consolidation)                          | Background memory consolidation with 4-phase cleanup — triggered by time and turn count.     |
| :page_facing_up:          | [**Magic Docs**](#magic-docs)                                                      | Self-updating markdown docs — files with a magic marker auto-refresh when stale.             |

---

### Memory That Persists Across Sessions and Channels

Every conversation is automatically indexed into a PostgreSQL-backed vector store. When the agent needs context from a past interaction — even one that happened in a different channel weeks ago — it finds it.

Under the hood: **pgvector** with hybrid retrieval (vector cosine similarity + full-text search, fused via RRF). Embeddings via Vertex AI `gemini-embedding-001` (768 dims). Falls back to FTS when embeddings aren't available.

### Adaptive Memory & User Model

When enabled (`NOMOS_ADAPTIVE_MEMORY=true`), the agent extracts structured knowledge from every conversation — facts, preferences, and corrections — using a lightweight LLM call (Haiku by default). Extracted knowledge accumulates into a persistent **user model** that personalizes responses across sessions.

- **Knowledge extraction** — facts about you, your projects, tech stack; preferences for coding style, communication, tools
- **Confidence-weighted** — repeated confirmations increase confidence; contradictions decrease it
- **Prompt injection** — high-confidence entries (>=0.6) are auto-injected into the system prompt

### Self-Improvement — An Agent That Evolves Itself

Nomos has a built-in `self-improve` skill that lets it analyze its own codebase, implement changes, and open pull requests to itself — all autonomously. Ask it to fix a bug, add a feature, write tests, or refactor its own code.

How it works:

1. Clones a fresh copy of its own repo (never modifies the running instance)
2. Analyzes the codebase and implements the requested change
3. Runs all checks (`pnpm check`, `pnpm test`, `pnpm build`)
4. Opens a PR for your review

Just say _"improve yourself"_, _"add tests for the chunker"_, or _"fix your session cleanup logic"_ — and review the PR when it's ready.

### Connect From Anywhere

| Protocol           | Port | Purpose                                                 |
| ------------------ | ---- | ------------------------------------------------------- |
| **gRPC**           | 8766 | Primary protocol for CLI, web, and mobile clients       |
| **WebSocket**      | 8765 | Legacy protocol (maintained for backward compatibility) |
| **Ink CLI**        | —    | Interactive terminal REPL with streaming markdown       |
| **Next.js Web UI** | 3456 | Settings dashboard and management interface             |

### Web-Based Management Dashboard

A full Next.js 16 app for onboarding, assistant configuration, channel management, and advanced settings — no YAML editing required. Includes a setup wizard (`/setup`), dashboard overview, per-channel integration management, and database/memory admin.

### Extend Without Forking

Add capabilities without modifying core code — drop in a skill file, point to an MCP server, or change a config value:

- **60+ bundled skills** covering GitHub, Google Workspace, document generation, design, and more
- **Three-tier skill loading**: ship your own skills per-project (`./skills/`), per-user (`~/.nomos/skills/`), or contribute upstream
- **MCP server support** — connect any [MCP-compatible tool server](https://modelcontextprotocol.io/) via `.nomos/mcp.json`
- **Config in the database** — everything persists in PostgreSQL, env vars work as fallback

### Deploy to 6 Platforms in Minutes

| Platform     | Mode             | Transport                                                |
| ------------ | ---------------- | -------------------------------------------------------- |
| **Slack**    | Bot Mode         | Socket Mode                                              |
| **Slack**    | User Mode        | Socket Mode + OAuth (multi-workspace, draft-before-send) |
| **Discord**  | Bot              | Gateway                                                  |
| **Telegram** | Bot              | grammY                                                   |
| **WhatsApp** | Bridge           | Baileys                                                  |
| **iMessage** | Read-only bridge | macOS Messages.app SQLite                                |

Each adapter is a thin layer (~50-100 LOC). All agent logic is centralized in `AgentRuntime`; adapters just route messages in and responses out.

### Smart Model Routing — Cut Costs Without Cutting Quality

Route queries to the right model automatically based on complexity. Works with **any provider** — Anthropic, OpenRouter, Ollama, or your own endpoint. Use Claude models, open-source local models, or mix and match:

- **Simple** (greetings, short questions) -> fast, cheap model (e.g. `claude-haiku-4-5`, `llama3`, or any local model)
- **Moderate** (general tasks) -> balanced model (e.g. `claude-sonnet-4-6`, `mistral-large`)
- **Complex** (coding, reasoning, multi-step) -> most capable model (e.g. `claude-opus-4-6`, `deepseek-r1`)

Run fully local with Ollama, optimize cloud costs across tiers, or combine local models for simple tasks with cloud models for complex ones.

Enable with `NOMOS_SMART_ROUTING=true`.

### Multiple API Providers

Run Nomos with the provider that fits your setup:

- **Anthropic** — direct API access (default)
- **Vertex AI** — Google Cloud managed API
- **OpenRouter** — unified billing, usage tracking via [openrouter.ai](https://openrouter.ai)
- **Ollama** — run local models via [LiteLLM](https://github.com/BerriAI/litellm) proxy
- **Custom** — any Anthropic-compatible endpoint via `ANTHROPIC_BASE_URL`

Switch providers in the Settings UI or via `NOMOS_API_PROVIDER`. See [API Providers](#api-providers) for setup details.

### Secrets Encrypted at Rest

API keys, OAuth tokens, and integration secrets never touch the database in plaintext. Everything is encrypted with **AES-256-GCM** before storage. A key is auto-generated on first run (`~/.nomos/encryption.key`), or bring your own via `ENCRYPTION_KEY`.

### Multi-Agent Teams — Parallelize Complex Work

Hand off a big task and let multiple agents tackle it simultaneously. A coordinator breaks the problem down, spawns parallel workers, and synthesizes their results into one response.

```
User prompt --> Coordinator --+--> Worker 1 (subtask A) --+
                              +--> Worker 2 (subtask B) --+--> Coordinator --> Final response
                              +--> Worker 3 (subtask C) --+
```

- Workers run in **parallel** with independent SDK sessions and scoped prompts
- Failed workers are gracefully handled — other workers' results are preserved
- Trigger with `/team` prefix: `/team Research React vs Svelte and write a comparison`
- Configure via `NOMOS_TEAM_MODE=true` and `NOMOS_MAX_TEAM_WORKERS=3`

### Image & Video Generation — Built In, Not Bolted On

Generate images (via Gemini) and videos (via Veo) directly from conversation. Ask your agent to create a logo, a product mockup, or a short video clip — it handles the API calls, saves the output, and returns the file. Opt-in via Settings UI or env vars.

- **Image generation** — `gemini-3-pro-image-preview`. Photorealistic images, illustrations, logos, concept art.
- **Video generation** — `veo-3.0-generate-preview`. Short cinematic clips with camera and style control.
- **Shared API key** — both use `GEMINI_API_KEY` from [Google AI Studio](https://aistudio.google.com/apikey)

---

## Advanced Agent Capabilities

Nomos goes beyond basic chat with a full suite of autonomous agent features:

### Interactive Browser Automation

Full Playwright-based browser control with persistent page sessions. Navigate, click, type, screenshot, and execute JavaScript — all from conversation. Perfect for login flows, form filling, scraping dynamic content, and visual verification.

Tools: `browser_navigate`, `browser_screenshot`, `browser_click`, `browser_type`, `browser_select`, `browser_evaluate`, `browser_snapshot`, `browser_close`

### Task State Machine & Dependency Graph

Every daemon operation is tracked as a task with lifecycle states (`pending → running → completed | failed | killed`). Tasks support dependency graphs — declare `blockedBy` relationships, and tasks auto-start when their dependencies complete. Includes cycle detection and abort-controller-based cancellation.

Tools: `task_status`, `task_kill`

### Sleep & Self-Resume

Agents can pause execution for up to an hour and resume with a wake-up prompt. Useful for polling deployments, waiting for async operations, or periodic monitoring within a session.

Tool: `agent_sleep`

### Plan Mode

For complex tasks, the agent proposes a structured plan (steps, affected files, risk levels) before execution. Plans are stored for review — approve, modify, or reject before any changes are made.

Tool: `propose_plan`

### LSP Code Intelligence

Language Server Protocol integration providing TypeScript/JavaScript code intelligence. Go-to-definition, find-all-references, hover for type info, and document symbols — powered by `typescript-language-server`.

Tools: `lsp_go_to_definition`, `lsp_find_references`, `lsp_hover`, `lsp_document_symbols`

### Proactive Messaging

The agent can send messages to your notification channels without being asked — for urgent alerts, monitoring results, or scheduled task output. Messages route through the daemon's channel manager via a process event bridge.

Tool: `proactive_send`

### Inter-Agent Messaging

During multi-agent team execution, workers communicate via an in-memory message bus with priority levels (normal, urgent, blocking). Workers can share intermediate results or report blockers to the coordinator.

Tools: `send_worker_message`, `check_worker_messages`

### Verification Agent

After team workers complete, a read-only adversarial agent runs tests, build, and lint to verify changes. Reports PASS/FAIL/PARTIAL with details.

### Memory Consolidation

Four-phase automatic memory cleanup: prune stale chunks (SQL), merge near-duplicates (vector similarity), LLM-powered review (Haiku), and confidence decay for outdated user model entries.

Tool: `memory_consolidate`

### Git Worktree Isolation

Team workers can operate in isolated git worktrees to avoid conflicts when modifying the same repo concurrently. Auto-cleanup if no changes were made.

### Cost Tracking

Per-session and per-model token usage and USD cost tracking. Supports all current Claude model pricing tiers (Haiku $1/$5, Sonnet $3/$15, Opus $5/$25 per Mtok). Session summaries show input/output/cache tokens and total spend. Available in the CLI via `/cost` and in the Settings UI at `/admin/costs`.

### Event Hooks

Extend the agent with event-driven hooks defined in `~/.nomos/hooks.json` or `.nomos/hooks.json`. Three hook types:

- **Command** — run a shell command with JSON context on stdin; exit code 2 blocks the tool call
- **HTTP** — POST to a webhook URL; 403 response blocks the tool call
- **Prompt** — return text to inject into context

Events: `PreToolUse`, `PostToolUse`, `Notification`, `Stop`, `SessionStart`, `SessionEnd`, `PreCompact`, `PostCompact`. Matchers support exact match, glob (`Tool(*)`), and wildcard (`*`).

### Context Visualization

See exactly how your context window is being used — system prompt, conversation, tools, memory, and skills — with a color-coded bar chart in the CLI and a web dashboard at `/admin/context`. Includes capacity warnings when context exceeds 75% or 90%.

### Bash Safety Analysis

Lightweight command analysis that detects potentially dangerous bash operations before execution. Checks for destructive commands (`rm`, `mkfs`), dangerous flags (`rm -rf`, `chmod 777`, `sudo`), network commands (`curl`, `ssh`), destructive git operations (`push --force`, `reset --hard`), and piping to shell. Risk levels: safe, low, medium, high, critical.

### Auto-Dream Memory Consolidation

Background memory consolidation triggered by time (1hr) and turn count (10) gates. Uses lock-file coordination to prevent concurrent runs. Four-phase consolidation:

1. **Orient** — survey existing memory structure
2. **Gather** — collect recent signals from conversations
3. **Consolidate** — write/update topic files, merge new knowledge
4. **Prune** — remove stale entries, update index

### Magic Docs

Markdown files with a `<!-- MAGIC DOC: title -->` marker are automatically kept up-to-date. When the system detects a magic doc is stale (based on update interval and file modification time), a background forked agent reads the codebase and refreshes the document in place — preserving the marker and structure.

### Adaptive Retry

API calls automatically retry with exponential backoff and jitter on transient errors (429 rate limits, 529 capacity errors). Respects `Retry-After` headers. Persistent mode for daemon sessions retries indefinitely. Configurable max retries (default: 8) with abort signal support.

### Prompt Cache Break Detection

Tracks SHA-256 hashes of system prompt, tool schemas, model, and beta flags across API calls. When a cache-invalidating change is detected, logs a warning with details of what changed — helping avoid unnecessary cache misses that increase costs.

### Forked Agents

Spawn lightweight, isolated subagent queries for background tasks — classifiers, summaries, magic doc updates, knowledge extraction. Uses Haiku by default for cost efficiency. Cost is tracked in the global singleton. `runParallelForks()` enables concurrent execution of multiple subagent queries.

### Tool Result Deduplication

Large tool results (>2000 chars) are deduplicated via SHA-256 content hashing. When the same result appears again, it's replaced with a compact reference. LRU eviction at 500 entries keeps memory bounded.

---

## Beyond the Basics

- **Digital marketing suite** — Google Ads + Analytics via MCP, with team mode workflows and daily briefings
- **Slack User Mode** — act as you: draft responses to your DMs for approval, then send as the authenticated user
- **Cron / scheduled tasks** — run prompts on a schedule with configurable targets and delivery modes
- **Session persistence** — all conversations stored in PostgreSQL with auto-resume and compaction
- **Personalization** — user profile, agent identity, SOUL.md personality, per-agent configs
- **30+ slash commands** — model switching, memory search, session management, and more
- **Proactive messaging** — send outbound messages to any channel outside the reply flow
- **Pairing system** — 8-character codes with TTL for channel access control

---

## Daemon Mode

The daemon turns Nomos into an always-on, multi-channel AI gateway. It boots an agent runtime, gRPC + WebSocket servers, channel adapters, and a cron engine — then processes incoming messages from all sources through a per-session message queue.

### How the Daemon Works

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
                   |  (Agent SDK)     |
                   +------------------+
```

1. **Gateway** boots all subsystems and installs signal handlers for graceful shutdown.
2. **Channel adapters** register automatically based on which environment variables are present (e.g., `SLACK_BOT_TOKEN` enables the Slack adapter).
3. **Message queue** serializes messages per session key — concurrent messages to the same conversation are processed sequentially; messages for different sessions process in parallel.
4. **Agent runtime** loads config, profile, identity, skills, and MCP servers once at startup, then processes each message through the agent SDK.

```bash
nomos daemon start    # Background mode
nomos daemon run      # Development mode (foreground with logs)
nomos daemon status   # Check if running
nomos daemon logs     # Tail logs
```

---

## Channel Integrations

Each channel adapter is automatically registered when its required environment variables are present. For detailed setup guides, see [docs/integrations/](docs/integrations/).

### Slack

Nomos integrates with Slack via [`nomos-slack-mcp`](https://github.com/project-nomos/nomos-slack-mcp), an external MCP server that provides channel/user name resolution, message formatting, search, reactions, and multi-workspace support.

```bash
# Add a Slack workspace (interactive OAuth or manual token)
npx nomos-slack-add-workspace

# Or for daemon bot mode (receives messages via Socket Mode):
SLACK_BOT_TOKEN=xoxb-...          # Bot User OAuth Token
SLACK_APP_TOKEN=xapp-...          # App-Level Token (Socket Mode)
SLACK_ALLOWED_CHANNELS=C123,C456  # Optional: restrict to specific channels
```

`nomos-slack-mcp` uses user tokens (`xoxp-`) stored in `~/.nomos/slack/config.json`, supporting `#channel-name` and `@username` resolution, message search, status updates, and reactions.

### Discord

```bash
DISCORD_BOT_TOKEN=...                     # Bot token from Discord Developer Portal
DISCORD_ALLOWED_CHANNELS=123456,789012    # Optional: restrict to specific channels
```

### Telegram

```bash
TELEGRAM_BOT_TOKEN=...                    # Token from @BotFather
TELEGRAM_ALLOWED_CHATS=123456,-789012     # Optional: restrict to specific chats
```

### WhatsApp

```bash
WHATSAPP_ENABLED=true
WHATSAPP_ALLOWED_CHATS=15551234567@s.whatsapp.net
```

Uses Baileys with QR code auth (no Meta Business API required). Auth state persisted to `~/.nomos/whatsapp-auth/`.

### Data Integrations (via MCP)

| Integration          | MCP Server                                                               | Guide                                          |
| -------------------- | ------------------------------------------------------------------------ | ---------------------------------------------- |
| **Google Ads**       | [google-ads-mcp](https://github.com/googleads/google-ads-mcp)            | [Setup](docs/integrations/google-ads.md)       |
| **Google Analytics** | [analytics-mcp](https://github.com/googleanalytics/google-analytics-mcp) | [Setup](docs/integrations/google-analytics.md) |
| **Google Workspace** | [@googleworkspace/cli](https://github.com/googleworkspace/cli)           | [Setup](docs/integrations/google-workspace.md) |

---

## API Providers

| Provider                | Description                       | Guide                                            |
| ----------------------- | --------------------------------- | ------------------------------------------------ |
| **Anthropic** (default) | Direct Anthropic API              | Set `ANTHROPIC_API_KEY`                          |
| **Vertex AI**           | Google Cloud Vertex AI            | Set `CLAUDE_CODE_USE_VERTEX=1` + GCP credentials |
| **OpenRouter**          | Anthropic models via OpenRouter   | [Setup guide](docs/integrations/openrouter.md)   |
| **Ollama**              | Local models via LiteLLM proxy    | [Setup guide](docs/integrations/ollama.md)       |
| **Custom**              | Any Anthropic-compatible endpoint | Set `ANTHROPIC_BASE_URL`                         |

---

## Skills System

Skills are markdown files (`SKILL.md`) with YAML frontmatter that provide domain-specific instructions to the agent. Loaded from three tiers: **bundled** (`skills/`) -> **personal** (`~/.nomos/skills/`) -> **project** (`./skills/`).

<details>
<summary><strong>All 60+ bundled skills</strong></summary>

| Skill                   | Description                                                    |
| ----------------------- | -------------------------------------------------------------- |
| `algorithmic-art`       | Generative art and creative coding                             |
| `apple-notes`           | Apple Notes integration                                        |
| `apple-reminders`       | Apple Reminders integration                                    |
| `brand-guidelines`      | Brand and style guide creation                                 |
| `canvas-design`         | Canvas-based design generation                                 |
| `digital-marketing`     | Google Ads + Analytics campaigns, team mode analysis workflows |
| `discord`               | Discord bot and integration help                               |
| `doc-coauthoring`       | Collaborative document writing                                 |
| `docx`                  | Word document generation                                       |
| `frontend-design`       | Frontend UI/UX design guidance                                 |
| `github`                | GitHub workflow and PR management                              |
| `image-generation`      | Image generation with Gemini (prompts, styles, capabilities)   |
| `gws-gmail`             | Gmail API (messages, drafts, labels)                           |
| `gws-drive`             | Google Drive (files, folders, permissions)                     |
| `gws-calendar`          | Google Calendar (events, scheduling)                           |
| `gws-sheets`            | Google Sheets (read, write, append)                            |
| `gws-docs`              | Google Docs (create, read, edit)                               |
| `gws-slides`            | Google Slides (presentations)                                  |
| `gws-shared`            | Google Workspace shared auth and conventions                   |
| `internal-comms`        | Internal communications drafting                               |
| `mcp-builder`           | MCP server development                                         |
| `pdf`                   | PDF document generation                                        |
| `pptx`                  | PowerPoint presentation generation                             |
| `self-improve`          | Self-improvement and learning                                  |
| `skill-creator`         | Create new skills from prompts                                 |
| `slack`                 | Slack app and integration help                                 |
| `slack-gif-creator`     | Slack GIF creation                                             |
| `telegram`              | Telegram bot and integration help                              |
| `theme-factory`         | Theme and color scheme generation                              |
| `video-generation`      | Video generation with Veo (camera, styles, prompt guidance)    |
| `weather`               | Weather information and forecasts                              |
| `web-artifacts-builder` | Web artifact (HTML/CSS/JS) creation                            |
| `webapp-testing`        | Web application testing guidance                               |
| `whatsapp`              | WhatsApp integration help                                      |
| `xlsx`                  | Excel spreadsheet generation                                   |

</details>

### Creating a custom skill

```bash
mkdir -p ~/.nomos/skills/my-skill
cat > ~/.nomos/skills/my-skill/SKILL.md << 'EOF'
---
name: my-skill
description: "What this skill does"
---

# My Skill

Instructions for the agent when this skill is active...
EOF
```

The bundled `skill-creator` skill can also generate skills on your behalf via conversation.

---

## Development

```bash
pnpm dev                # Run in dev mode (tsx, no build needed)
pnpm build              # Build with tsdown -> dist/index.js
pnpm typecheck          # TypeScript type check (tsc --noEmit)
pnpm test               # Run tests (vitest)
pnpm lint               # Lint (oxlint)
pnpm check              # Full check (format + typecheck + lint)
pnpm daemon:dev         # Run daemon in dev mode (tsx)
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, architecture, code conventions, and how to submit pull requests.

---

<details>
<summary><strong>Configuration Reference</strong></summary>

Configuration is loaded with the following precedence: **Database > environment variables > hardcoded defaults**. Environment variables are loaded from `~/.nomos/.env` (primary) and `.env` in the current directory (fallback). API keys and secrets are stored encrypted (AES-256-GCM) in the `integrations` table.

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
| `CLOUD_ML_REGION`        | Vertex AI region                        | --      |

### Model and behavior

| Variable                 | Description                                                                   | Default             |
| ------------------------ | ----------------------------------------------------------------------------- | ------------------- |
| `NOMOS_MODEL`            | Default Claude model                                                          | `claude-sonnet-4-6` |
| `NOMOS_PERMISSION_MODE`  | Tool permission mode (default, acceptEdits, plan, dontAsk, bypassPermissions) | `acceptEdits`       |
| `NOMOS_SMART_ROUTING`    | Enable complexity-based model routing                                         | `false`             |
| `NOMOS_TEAM_MODE`        | Enable multi-agent team orchestration                                         | `false`             |
| `NOMOS_MAX_TEAM_WORKERS` | Max parallel workers in team mode                                             | `3`                 |
| `NOMOS_ADAPTIVE_MEMORY`  | Enable knowledge extraction and user model learning                           | `false`             |
| `NOMOS_IMAGE_GENERATION` | Enable image generation via Gemini                                            | `false`             |
| `GEMINI_API_KEY`         | Gemini API key (shared by image and video generation)                         | --                  |
| `NOMOS_VIDEO_GENERATION` | Enable video generation via Veo                                               | `false`             |
| `ANTHROPIC_BASE_URL`     | Custom Anthropic API base URL (Ollama, LiteLLM, etc.)                         | --                  |

### Channel integrations

| Variable             | Description                         | Default |
| -------------------- | ----------------------------------- | ------- |
| `SLACK_BOT_TOKEN`    | Slack Bot User OAuth Token          | --      |
| `SLACK_APP_TOKEN`    | Slack App-Level Token (Socket Mode) | --      |
| `DISCORD_BOT_TOKEN`  | Discord bot token                   | --      |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token from @BotFather  | --      |
| `WHATSAPP_ENABLED`   | Set to `true` to enable WhatsApp    | --      |

See `.env.example` for the complete list of all configuration options.

</details>

<details>
<summary><strong>gRPC & WebSocket Protocols</strong></summary>

### gRPC

Clients communicate via gRPC on `localhost:8766`. The service is defined in [`proto/nomos.proto`](proto/nomos.proto).

```protobuf
service NomosAgent {
  rpc Chat (ChatRequest) returns (stream AgentEvent);
  rpc Command (CommandRequest) returns (CommandResponse);
  rpc GetStatus (Empty) returns (StatusResponse);
  rpc ListSessions (Empty) returns (SessionList);
  rpc GetSession (SessionRequest) returns (SessionResponse);
  rpc ListDrafts (Empty) returns (DraftList);
  rpc ApproveDraft (DraftAction) returns (DraftResponse);
  rpc RejectDraft (DraftAction) returns (DraftResponse);
  rpc Ping (Empty) returns (PongResponse);
}
```

The `.proto` file can generate native clients for iOS (Swift), Android (Kotlin), and other platforms.

### WebSocket (Legacy)

The WebSocket server runs on `ws://localhost:8765` for backwards compatibility. See the [protocol documentation](docs/websocket-protocol.md) for message formats.

</details>

<details>
<summary><strong>Slash Commands</strong></summary>

| Command                       | Description                                                 |
| ----------------------------- | ----------------------------------------------------------- |
| `/clear`                      | Clear conversation context                                  |
| `/compact`                    | Compact conversation to reduce context usage                |
| `/status`                     | Show system status overview                                 |
| `/model <name>`               | Switch model                                                |
| `/thinking <level>`           | Set thinking level (off, minimal, low, medium, high, max)   |
| `/profile set <key> <value>`  | Set profile field (name, timezone, workspace, instructions) |
| `/identity set <key> <value>` | Set agent identity (name, emoji)                            |
| `/skills`                     | List loaded skills                                          |
| `/memory search <query>`      | Search the vector memory                                    |
| `/drafts`                     | List pending draft responses (Slack User Mode)              |
| `/approve <id>`               | Approve a draft                                             |
| `/config set <key> <value>`   | Change a setting                                            |
| `/tools`                      | List available tools                                        |
| `/mcp`                        | List MCP servers                                            |
| `/quit`                       | Exit Nomos                                                  |

</details>

<details>
<summary><strong>Settings Web UI</strong></summary>

A local Next.js app at `settings/` for managing your assistant via the browser (port 3456).

| Route             | Description                                                                     |
| ----------------- | ------------------------------------------------------------------------------- |
| `/setup`          | 5-step onboarding wizard (database, API, personality, channels, ready)          |
| `/dashboard`      | Overview: assistant status, model, active channels, memory stats, quick actions |
| `/settings`       | Assistant identity, API config, model, advanced settings                        |
| `/integrations`   | Channel overview and per-platform configuration                                 |
| `/admin/database` | Database connection and migration status                                        |
| `/admin/memory`   | Memory store stats and management                                               |
| `/admin/costs`    | Session cost tracking and per-model usage breakdown                             |
| `/admin/context`  | Context window visualization with token budget breakdown                        |

```bash
nomos settings              # Start on http://localhost:3456 and open browser
nomos settings --port 4000  # Custom port
```

</details>

---

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, testing, code conventions, and how to submit pull requests.

## License

[MIT](LICENSE)
