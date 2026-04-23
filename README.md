<p align="center">
  <img src="images/project-nomos-header.png" alt="Project Nomos" width="100%" />
</p>

<p align="center">
  <strong>Your AI digital clone — learns who you are, acts on your behalf, remembers everything, and represents you across every platform</strong><br/>
  Multi-provider (Anthropic, OpenRouter, Vertex AI, Ollama). Self-hosted. Encrypted. MIT licensed.
</p>

<p align="center">
  <a href="#get-running-in-2-minutes">Quick Start</a> &middot;
  <a href="#why-nomos">Why Nomos</a> &middot;
  <a href="#what-you-get">Features</a> &middot;
  <a href="#digital-clone">Digital Clone</a> &middot;
  <a href="#channel-integrations">Channels</a> &middot;
  <a href="#skills-system">Skills</a> &middot;
  <a href="#plugins">Plugins</a> &middot;
  <a href="#daemon-mode">Daemon</a> &middot;
  <a href="CONTRIBUTING.md">Contributing</a>
</p>

<p align="center">
  <a href="https://github.com/project-nomos/nomos/releases"><img src="https://img.shields.io/github/v/release/project-nomos/nomos" alt="Release" /></a>
  <a href="https://github.com/project-nomos/nomos/actions/workflows/ci.yml"><img src="https://github.com/project-nomos/nomos/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License" /></a>
  <img src="https://img.shields.io/badge/Claude_Agent_SDK-powered-6B4FBB?logo=anthropic" alt="Claude Agent SDK" />
  <img src="https://img.shields.io/badge/skills-60+-10b981" alt="60+ Skills" />
  <img src="https://img.shields.io/badge/MCP-compatible-10b981?logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxNiIgaGVpZ2h0PSIxNiIgZmlsbD0id2hpdGUiIHZpZXdCb3g9IjAgMCAxNiAxNiI+PGNpcmNsZSBjeD0iOCIgY3k9IjgiIHI9IjMiLz48L3N2Zz4=" alt="MCP Compatible" />
  <a href="https://github.com/project-nomos/nomos/stargazers"><img src="https://img.shields.io/github/stars/project-nomos/nomos?style=flat" alt="Stars" /></a>
</p>

<!-- TODO: Add demo GIF here — record a 30-second terminal session showing:
     1. `nomos chat` startup with gradient spinner
     2. "Prep me for my 2pm — check Slack, my recent emails, and what we discussed last week" — the clone acting on your behalf
     3. "Draft a reply to Sarah as me and schedule the follow-up" — representing you, not just answering questions
     Ideal size: 800x450, < 5MB, hosted on GitHub
-->
<!-- <p align="center">
  <img src="images/demo.gif" alt="Nomos demo" width="700" />
</p> -->

---

## Why Nomos?

Most AI assistants are stateless chatbots that forget you the moment a conversation ends. Nomos is building toward something different: an **AI digital clone** that knows you deeply, acts on your behalf, and gets smarter with every interaction.

- **Ingests your history** -- Import years of Messages.app, Gmail, and WhatsApp messages for deep context. The clone learns primarily from direct conversations and draft edits -- when you modify a draft before approving, the edit is captured as a learning signal. CLI manual ingestion (`nomos ingest slack --since DATE`) is available for on-demand imports.
- **Learns your voice** — Per-contact communication style model analyzes how you write — formality, length, emoji, greetings — and drafts messages in your authentic voice. Different tone for your manager vs. your friends.
- **Compiles knowledge** — A Karpathy-style knowledge wiki transforms raw messages into structured articles about your contacts, projects, and topics. The clone reads compiled knowledge first, RAG second.
- **Unified identity graph** — Links contacts across Slack, email, Messages.app, Discord, Telegram, and WhatsApp. One person, one profile, regardless of which platform they message you on.
- **Acts on your behalf** -- Drafts and sends emails, manages your calendar, preps meeting briefs, tracks commitments, follows up, triages across channels. Per-platform consent modes: `always_ask` (draft + approve), `auto_approve` (send immediately + FYI), `notify_only` (just notify, no response). Per-contact autonomy layered on top: auto-send, draft-for-approval, or silent.
- **Remembers everything** — Every conversation is auto-indexed into vector memory. Ask "what did we decide about the API migration last week?" and it knows — across channels, across sessions.
- **Reads you in real time** — A Theory of Mind engine tracks your mental state per session — focus level, emotional signals, urgency, whether you're stuck. Rule-based signals run every turn; a background LLM assessment catches sarcasm, implicit frustration, and goal shifts every few turns. The agent adapts its response style automatically.
- **Represents you everywhere** — Slack, Discord, Telegram, WhatsApp, Messages.app, Email, terminal, web. Slack User Mode lets it draft and send messages as you. It's not a bot in your channel — it's you, augmented.
- **Agent-to-agent trust** — CATE protocol (Consumer Agent Trust Envelope) enables secure communication between your clone and other agents with DID-based identity, verifiable credentials, policy enforcement, and anti-spam stamps.
- **Multi-provider** — Anthropic, Vertex AI, OpenRouter, Ollama, or any compatible endpoint. Smart routing sends simple queries to fast models and complex ones to capable models — cutting costs 5-10x automatically.
- **60+ built-in skills** — Gmail, Calendar, Drive, Docs, Sheets, document generation, image/video creation, browser automation, and more.
- **Always on** — Runs as a background daemon with scheduled tasks, proactive notifications, and a web management dashboard.
- **Multi-agent teams** — A coordinator decomposes complex tasks, spawns parallel workers, and synthesizes results.
- **Encrypted & self-hosted** — AES-256-GCM for all secrets. Your clone stays on your infrastructure. Built on Anthropic's [Claude Agent SDK](https://docs.anthropic.com/en/docs/claude-code/sdk).

---

## Get Running in 2 Minutes

```bash
# Homebrew (recommended)
brew tap project-nomos/nomos https://github.com/project-nomos/nomos
brew install project-nomos/nomos/nomos

# Then just:
nomos chat
```

That's it. The daemon and Settings UI start automatically after install. A browser-based setup wizard handles the rest — database connection, API provider, assistant personality, and channel integrations. Everything is saved encrypted in PostgreSQL.

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

<details>
<summary><strong>Database setup</strong></summary>

Nomos requires PostgreSQL with the [pgvector](https://github.com/pgvector/pgvector) extension. Choose whichever method suits your setup:

#### Option A: Homebrew (macOS)

PostgreSQL and pgvector are separate packages — you need both:

```bash
# 1. Install PostgreSQL
brew install postgresql@17
brew services start postgresql@17

# 2. Install the pgvector extension
brew install pgvector

# 3. Create the database
createdb nomos

# 4. Set your connection string
export DATABASE_URL=postgresql://localhost:5432/nomos
```

#### Option B: Docker (recommended — includes pgvector out of the box)

The `pgvector/pgvector` image bundles PostgreSQL + pgvector together, no separate install needed:

```bash
docker run -d --name nomos-db \
  -e POSTGRES_USER=nomos \
  -e POSTGRES_PASSWORD=nomos \
  -e POSTGRES_DB=nomos \
  -p 5432:5432 \
  pgvector/pgvector:pg17

export DATABASE_URL=postgresql://nomos:nomos@localhost:5432/nomos
```

#### Option C: Docker Compose (included in repo)

```bash
docker compose up -d db
export DATABASE_URL=postgresql://nomos:nomos@localhost:5432/nomos
```

#### Then run migrations

```bash
nomos db migrate    # Creates all tables, enables pgvector extension
```

The setup wizard handles this automatically when you run `nomos chat` for the first time, but you can also run migrations manually at any time (they're idempotent).

> **Already have PostgreSQL installed another way?** (Postgres.app, Linux package manager, etc.) — just install pgvector separately following the [pgvector install guide](https://github.com/pgvector/pgvector#installation), create a database, and set `DATABASE_URL`.

</details>

---

## What You Get

|                           | Feature                                     | What it does                                                                                                                       |
| ------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| :dna:                     | [**Data Ingestion**](#digital-clone)        | Import years of Slack, Gmail, Messages.app, Discord, Telegram, and WhatsApp history. Auto-sync on connect + continuous delta sync. |
| :pen:                     | [**Voice Modeling**](#digital-clone)        | Per-contact style analysis — formality, length, emoji, greetings. Drafts in your voice.                                            |
| :books:                   | [**Knowledge Wiki**](#digital-clone)        | LLM-compiled articles about your contacts, projects, and topics. Structured knowledge.                                             |
| :link:                    | [**Identity Graph**](#digital-clone)        | Unified contacts across all platforms. One person, one profile.                                                                    |
| :shield:                  | [**CATE Protocol**](#digital-clone)         | Agent-to-agent trust with DIDs, verifiable credentials, policy, and anti-spam stamps.                                              |
| :brain:                   | [**Persistent Memory**](#features-in-depth) | Every conversation auto-indexed into pgvector. Recall anything from any session or channel.                                        |
| :crystal_ball:            | [**Theory of Mind**](#features-in-depth)    | Hybrid rule + LLM per-session mental state tracking. Detects frustration, urgency, goal shifts, stuck patterns.                    |
| :speech_balloon:          | [**7 Channels**](#channel-integrations)     | Slack, Discord, Telegram, WhatsApp, Messages.app, Email — thin adapters, one agent runtime.                                        |
| :busts_in_silhouette:     | [**Multi-Agent Teams**](#features-in-depth) | Coordinator + parallel workers. Hand off complex tasks, get synthesized results.                                                   |
| :zap:                     | [**Smart Routing**](#features-in-depth)     | Route by complexity across any provider — cloud, local, or hybrid.                                                                 |
| :art:                     | [**Image & Video Gen**](#features-in-depth) | Gemini image + Veo video generation, conversational — just ask.                                                                    |
| :desktop_computer:        | [**Web Dashboard**](#features-in-depth)     | Next.js settings UI with setup wizard. No YAML editing.                                                                            |
| :jigsaw:                  | [**60+ Skills**](#skills-system)            | Three-tier loading: bundled, personal, project. Create your own in minutes.                                                        |
| :lock:                    | [**Encrypted Secrets**](#features-in-depth) | AES-256-GCM for all API keys and tokens. Auto-key on first run.                                                                    |
| :globe_with_meridians:    | [**5 API Providers**](#features-in-depth)   | Anthropic, Vertex AI, OpenRouter, Ollama, or any compatible endpoint.                                                              |
| :arrows_counterclockwise: | [**Self-Improvement**](#features-in-depth)  | Nomos can analyze its own code, implement fixes, and open PRs to itself.                                                           |
| :sleeping:                | [**Sleep & Resume**](#features-in-depth)    | Agents pause and wake with a prompt — for polling, monitoring, and async waits.                                                    |
| :anchor:                  | [**Event Hooks**](#features-in-depth)       | Command, HTTP, or prompt hooks on tool use, lifecycle, and compaction.                                                             |
| :crescent_moon:           | [**Auto-Dream**](#features-in-depth)        | Background memory consolidation with 4-phase cleanup.                                                                              |
| :package:                 | [**Plugins**](#plugins)                     | 21 pre-installed plugins from the Claude marketplace — PR review, code review, GitHub, Linear, Playwright, and more.               |
| :moneybag:                | [**Cost Tracking**](#features-in-depth)     | Per-model pricing, session costs, usage breakdown in CLI and web dashboard.                                                        |

---

## Channel Integrations

| Platform         | Mode            | Transport                                                                                 |
| ---------------- | --------------- | ----------------------------------------------------------------------------------------- |
| **Slack**        | Bot + User Mode | Web API polling + OAuth (multi-workspace, draft-before-send)                              |
| **Discord**      | Bot             | Gateway                                                                                   |
| **Telegram**     | Bot             | grammY                                                                                    |
| **WhatsApp**     | Bridge          | Baileys (no Meta Business API needed)                                                     |
| **Messages.app** | Dual mode       | Local chat.db or BlueBubbles. Passive (draft & approve) or agent client (direct to owner) |
| **Email**        | IMAP + SMTP     | IMAP IDLE for real-time push, SMTP for sending                                            |
| **Web/gRPC**     | Client          | gRPC (8766) + WebSocket (8765)                                                            |

Each adapter is ~50-100 LOC. All agent logic is centralized in `AgentRuntime`. See [docs/channels.md](docs/channels.md) for env vars and setup, or the [individual integration guides](docs/integrations/).

---

## Skills System

Skills are markdown files (`SKILL.md`) with YAML frontmatter that provide domain-specific instructions to the agent. Loaded from three tiers: **bundled** (`skills/`) → **personal** (`~/.nomos/skills/`) → **project** (`./skills/`).

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

## Plugins

Nomos supports plugins from the Claude Code ecosystem — extending the agent with additional skills, agents, hooks, and MCP servers. 21 plugins are pre-installed at build time; browse and install more from the Claude marketplace via CLI.

```bash
nomos plugin list                   # Show installed plugins (21 pre-installed)
nomos plugin available              # Browse all marketplace plugins
nomos plugin install <name>         # Install a plugin
nomos plugin remove <name>          # Remove a plugin
```

### Pre-installed plugins (21)

**14 first-party** — agent-sdk-dev, code-review, code-simplifier, commit-commands, feature-dev, frontend-design, hookify, learning-output-style, math-olympiad, mcp-server-dev, plugin-dev, pr-review-toolkit, security-guidance, skill-creator

**7 community** — discord, github, imessage, linear, playwright, telegram, terraform

Plugins are fetched at install time from `github.com/anthropics/claude-plugins-official` (Apache 2.0) — not bundled in the repo. They're loaded into every SDK session — CLI, daemon, and team workers. See [docs/plugins.md](docs/plugins.md) for the full list and architecture details.

---

## Daemon Mode

The daemon turns Nomos into an always-on, multi-channel AI gateway. It boots an agent runtime, gRPC + WebSocket servers, channel adapters, and a cron engine — then processes incoming messages from all sources through a per-session message queue.

```bash
nomos daemon start               # Background mode (includes Settings UI)
nomos daemon run                 # Development mode (foreground with logs)
nomos daemon stop                # Stop running daemon
nomos daemon status              # Check if running

nomos service install            # Install as launchd service (auto-start on login)
nomos service uninstall          # Remove launchd service
```

<details>
<summary><strong>How the daemon works</strong></summary>

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
2. **Channel adapters** register automatically based on which environment variables are present.
3. **Message queue** serializes messages per session key — concurrent sessions process in parallel.
4. **Agent runtime** loads config, profile, identity, skills, and MCP servers once at startup.

</details>

---

## Digital Clone

The digital clone features transform Nomos from a stateless chatbot into a persistent representation of you.

<details>
<summary><strong>Historical Data Ingestion</strong></summary>

Import communication history from Messages.app, Gmail, and WhatsApp. The ingestion pipeline deduplicates, chunks, embeds, and stores messages in pgvector-backed memory. Auto-triggered bulk ingestion on channel connect has been retired for Slack, Discord, and Telegram -- the agent now learns primarily from direct conversations, draft edits, and knowledge extraction. CLI manual ingestion still works for on-demand imports. iMessage and Email ingestion is retained for style model training.

```bash
nomos ingest imessage --since 2024-01-01              # Import Messages.app history
nomos ingest slack --since 2024-06-01                 # Import Slack (sent only)
nomos ingest gmail --since 2024-01-01                 # Import Gmail (sent only)
nomos ingest discord --since 2024-01-01               # Import Discord (sent only)
nomos ingest telegram                                  # Import Telegram (sent only)
nomos ingest status                                    # Check sync status
```

Smart filtering: Slack, Gmail, Discord, and Telegram ingest only sent messages. Messages.app and WhatsApp ingest both directions for context, but style modeling uses sent messages exclusively.

See [docs/ingestion.md](docs/ingestion.md) for full details.

</details>

<details>
<summary><strong>Communication Style Model</strong></summary>

Analyzes your sent messages to learn how you write — globally and per contact. Extracts formality level, typical message length, emoji usage, punctuation habits, greeting and sign-off patterns. The resulting `StyleProfile` is injected into the system prompt when drafting messages.

- **Global profile** — Your overall writing voice
- **Per-contact overrides** — More formal with your manager, casual with friends
- **Confidence-tracked** — Warns when sample count is too low for reliable modeling

See [docs/style-model.md](docs/style-model.md) for full details.

</details>

<details>
<summary><strong>Knowledge Wiki</strong></summary>

A Karpathy-style compiled knowledge base. An LLM periodically compiles raw ingested messages into structured markdown articles organized by contact, topic, and timeline. The agent reads compiled wiki articles first (cheap, structured), falls back to vector search for details.

```
~/.nomos/wiki/
  contacts/sarah-chen.md     # Everything about Sarah
  topics/kubernetes.md        # Cross-contact topic synthesis
  timeline/2026-04.md         # Monthly activity digest
```

Articles stored in PostgreSQL (source of truth) and synced to disk as a browsable cache.

See [docs/knowledge-wiki.md](docs/knowledge-wiki.md) for full details.

</details>

<details>
<summary><strong>Theory of Mind</strong></summary>

A hybrid per-session engine that models the user's mental state in real time so the agent can adapt its response style.

**Layer 1 -- Rule-based (every turn, zero latency):** Detects surface signals from message patterns -- urgency markers ("asap", "blocking"), explicit emotions ("frustrated", "awesome"), correction frequency, question rate, session duration, time of day. Produces focus/emotion/load/urgency/energy dimensions.

**Layer 2 -- LLM reasoning (every 3 turns, background):** A Haiku-powered background assessment analyzes the last 10 messages for what the rules miss -- sarcasm, passive aggression, implicit goal shifts, whether "this is fine" means acceptance or resignation, and whether the conversation is progressing or going in circles. Runs via `runForkedAgent` in parallel with the main response (zero added latency). Results merge into the system prompt on the next turn.

The combined state appears in the system prompt as "Current User State" with response guidance (e.g., "Be concise and action-oriented" when urgency is high, "Acknowledge the difficulty" when frustration is detected).

Theory of Mind is one of 8 interconnected subsystems that make Nomos think like you, not just sound like you. See [docs/think-like-you.md](docs/think-like-you.md) for the full architecture: knowledge extraction, decision pattern learning, exemplar curation, shadow observation, calibration, personality DNA, and more.

</details>

<details>
<summary><strong>Cross-Channel Identity Graph</strong></summary>

Unified contacts linking Slack ID, email, phone, Discord, and more into a single profile. Auto-linking heuristics merge contacts by display name, email, or user confirmation. Per-contact autonomy levels control how the clone handles outgoing messages:

| Level    | Behavior                            |
| -------- | ----------------------------------- |
| `auto`   | Send immediately, no approval       |
| `draft`  | Create draft for approval (default) |
| `silent` | Observe only, don't respond         |

```bash
nomos contacts list                              # List all contacts
nomos contacts link <id> slack U12345678         # Link identity
nomos contacts merge <id1> <id2>                 # Merge contacts
```

See [docs/contacts.md](docs/contacts.md) for full details.

</details>

<details>
<summary><strong>CATE Protocol (Agent-to-Agent Trust)</strong></summary>

Secure agent-to-agent communication via the Consumer Agent Trust Envelope protocol. Built on `@project-nomos/cate-sdk` — a standalone, open-source library.

- **DID-based identity** — Ed25519 key pairs with `did:key` identifiers
- **Verifiable Credentials** — "Acts-for" VCs prove the agent acts on behalf of the user
- **Policy engine** — Per-intent rules: allow personal, require approval for transactional, require stamps for promotional
- **Anti-spam stamps** — Proof-of-work or micropayment stamps for unsolicited messages
- **Signed Agent Cards** — A2A-compatible discovery format

The CATE server starts automatically with the daemon on port 8801.

See [docs/cate-protocol.md](docs/cate-protocol.md) for full details.

</details>

<details>
<summary><strong>Proactive Agency</strong></summary>

Beyond reactive responses — the clone tracks commitments, generates pre-meeting briefs, and triages across channels.

- **Commitment tracking** — Extracts "I'll do X by Y" from conversations, tracks deadlines, sends reminders
- **Meeting briefs** — Before meetings, looks up attendees in the identity graph, retrieves recent conversations, generates context
- **Priority triage** — Aggregates unread across channels, ranks by sender importance and urgency

</details>

---

## Features in Depth

<details>
<summary><strong>Memory & Adaptive Learning</strong></summary>

### Persistent Vector Memory

Every conversation is automatically indexed into a PostgreSQL-backed vector store. When the agent needs context from a past interaction — even one that happened in a different channel weeks ago — it finds it.

Under the hood: **pgvector** with hybrid retrieval (vector cosine similarity + full-text search, fused via RRF). Embeddings via Vertex AI `gemini-embedding-001` (768 dims). Falls back to FTS when embeddings aren't available.

### Adaptive Memory & User Model

When enabled (`NOMOS_ADAPTIVE_MEMORY=true`), the agent extracts structured knowledge from every conversation — facts, preferences, and corrections — using a lightweight LLM call (Haiku by default). Extracted knowledge accumulates into a persistent **user model** that personalizes responses across sessions.

- **Knowledge extraction** — facts about you, your projects, tech stack; preferences for coding style, communication, tools
- **Confidence-weighted** — repeated confirmations increase confidence; contradictions decrease it
- **Prompt injection** — high-confidence entries (>=0.6) are auto-injected into the system prompt

### Auto-Dream Memory Consolidation

Background memory consolidation triggered by time (1hr) and turn count (10) gates. Uses lock-file coordination to prevent concurrent runs. Four-phase consolidation: Orient → Gather → Consolidate → Prune.

### Magic Docs

Markdown files with a `<!-- MAGIC DOC: title -->` marker are automatically kept up-to-date. When the system detects a magic doc is stale, a background forked agent reads the codebase and refreshes the document in place.

</details>

<details>
<summary><strong>Multi-Agent Teams & Smart Routing</strong></summary>

### Multi-Agent Teams

A coordinator agent decomposes complex tasks, spawns parallel workers via independent `runSession()` calls, collects results with `Promise.allSettled()`, and synthesizes a final response. Workers share MCP servers and permissions but get scoped system prompts. Triggered by `/team` prefix.

### Smart Model Routing

Route queries to the right model automatically based on complexity. Works with **any provider** — Anthropic, OpenRouter, Ollama, or your own endpoint:

- **Simple** (greetings, short questions) → fast, cheap model (e.g. `claude-haiku-4-5`, `llama3`)
- **Moderate** (general tasks) → balanced model (e.g. `claude-sonnet-4-6`, `mistral-large`)
- **Complex** (coding, reasoning, multi-step) → most capable model (e.g. `claude-opus-4-6`, `deepseek-r1`)

Enable with `NOMOS_SMART_ROUTING=true`.

</details>

<details>
<summary><strong>Image & Video Generation</strong></summary>

Built-in image generation via Gemini and video generation via Veo. Conversational — just describe what you want. Supports style presets, aspect ratios, and iterative refinement. Enable with `NOMOS_IMAGE_GENERATION=true` and/or `NOMOS_VIDEO_GENERATION=true` plus a `GEMINI_API_KEY`.

</details>

<details>
<summary><strong>Self-Improvement</strong></summary>

Nomos has a built-in `self-improve` skill that lets it analyze its own codebase, implement changes, and open pull requests to itself — all autonomously.

1. Clones a fresh copy of its own repo (never modifies the running instance)
2. Analyzes the codebase and implements the requested change
3. Runs all checks (`pnpm check`, `pnpm test`, `pnpm build`)
4. Opens a PR for your review

Just say _"improve yourself"_, _"add tests for the chunker"_, or _"fix your session cleanup logic"_.

</details>

<details>
<summary><strong>API Providers</strong></summary>

| Provider                | Description                       | Guide                                            |
| ----------------------- | --------------------------------- | ------------------------------------------------ |
| **Anthropic** (default) | Direct Anthropic API              | Set `ANTHROPIC_API_KEY`                          |
| **Vertex AI**           | Google Cloud Vertex AI            | Set `CLAUDE_CODE_USE_VERTEX=1` + GCP credentials |
| **OpenRouter**          | Anthropic models via OpenRouter   | [Setup guide](docs/integrations/openrouter.md)   |
| **Ollama**              | Local models via LiteLLM proxy    | [Setup guide](docs/integrations/ollama.md)       |
| **Custom**              | Any Anthropic-compatible endpoint | Set `ANTHROPIC_BASE_URL`                         |

</details>

<details>
<summary><strong>Web Dashboard & Settings UI</strong></summary>

A full Next.js app for onboarding, assistant configuration, channel management, and advanced settings — no YAML editing required.

| Route              | Description                                                                       |
| ------------------ | --------------------------------------------------------------------------------- |
| `/setup`           | 6-step onboarding wizard (database, API, personality, channels, data sync, ready) |
| `/dashboard`       | Overview: assistant status, model, active channels, memory stats, quick actions   |
| `/settings`        | Assistant identity, API config, model, advanced settings                          |
| `/integrations`    | Channel overview and per-platform configuration (incl. email)                     |
| `/admin/database`  | Database connection and migration status                                          |
| `/admin/memory`    | Memory store stats and management                                                 |
| `/admin/costs`     | Session cost tracking and per-model usage breakdown                               |
| `/admin/context`   | Context window visualization with token budget breakdown                          |
| `/admin/ingestion` | Data ingestion dashboard: sync status, counts, trigger sync, delta toggle         |
| `/admin/contacts`  | Contact management: identities, autonomy levels, merge/split                      |
| `/admin/proactive` | Proactive features: commitments, triage, meeting briefs                           |

```bash
nomos settings              # Start standalone on http://localhost:3456
nomos settings --port 4000  # Custom port
# Note: Settings UI also starts automatically with the daemon
```

</details>

<details>
<summary><strong>Browser Automation, Tasks, Hooks & More</strong></summary>

- **Browser automation** — Playwright-based with persistent sessions across tool calls
- **Task state machine** — lifecycle tracking with dependency graphs, auto-unblock, and cancellation
- **Sleep & self-resume** — agents pause and wake with a prompt for polling, monitoring, and async waits
- **Plan mode** — agent proposes structured plans for review before making changes
- **LSP code intelligence** — go-to-definition, find-references, hover, document symbols via TypeScript LSP
- **Event hooks** — command, HTTP, or prompt hooks on tool use, lifecycle, and compaction events
- **Cost tracking** — per-model pricing tiers, session cost summaries, usage breakdown in CLI and web dashboard
- **Context visualization** — see how your context window is used (system prompt, conversation, tools, memory, skills)
- **Bash safety analysis** — detects destructive commands, dangerous flags, elevated privileges before execution
- **Proactive messaging** — send outbound messages to any channel outside the reply flow
- **Adaptive retry** — exponential backoff with jitter, retry-after headers, persistent mode for daemon
- **Tool result deduplication** — SHA-256 hashing to deduplicate large tool results across turns
- **Prompt cache break detection** — logs warnings when system prompt changes would invalidate caches
- **Digital marketing suite** — Google Ads + Analytics via MCP
- **Slack User Mode** — act as you: draft responses for approval, then send as authenticated user
- **Cron / scheduled tasks** — run prompts on a schedule with configurable delivery modes
- **30+ slash commands** — model switching, memory search, session management, and more

</details>

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

| Variable                  | Description                           | Default   |
| ------------------------- | ------------------------------------- | --------- |
| `SLACK_BOT_TOKEN`         | Slack Bot User OAuth Token            | --        |
| `SLACK_APP_TOKEN`         | Slack App-Level Token (Socket Mode)   | --        |
| `DISCORD_BOT_TOKEN`       | Discord bot token                     | --        |
| `TELEGRAM_BOT_TOKEN`      | Telegram bot token from @BotFather    | --        |
| `WHATSAPP_ENABLED`        | Set to `true` to enable WhatsApp      | --        |
| `IMESSAGE_ENABLED`        | Set to `true` to enable Messages.app  | --        |
| `IMESSAGE_MODE`           | `chatdb` (macOS) or `bluebubbles`     | `chatdb`  |
| `IMESSAGE_AGENT_MODE`     | `passive` (draft) or `agent` (direct) | `passive` |
| `IMESSAGE_OWNER_PHONE`    | Owner phone for agent mode            | --        |
| `IMESSAGE_OWNER_APPLE_ID` | Owner Apple ID for agent mode         | --        |
| `BLUEBUBBLES_SERVER_URL`  | BlueBubbles server URL                | --        |
| `BLUEBUBBLES_PASSWORD`    | BlueBubbles API password              | --        |

Email is configured via the Settings UI (`/integrations/email`) or the `integrations` table (IMAP/SMTP host, port, credentials).

See `.env.example` for the complete list of all configuration options.

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
| `/plugins`                    | List loaded plugins                                         |
| `/quit`                       | Exit Nomos                                                  |

</details>

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

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, testing, code conventions, and how to submit pull requests.

## License

[MIT](LICENSE)
