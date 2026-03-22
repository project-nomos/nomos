# Settings Web UI

A local web-based interface for setting up and managing Nomos. Built with Next.js 15, it provides a guided onboarding wizard, a dashboard overview, assistant personality configuration, channel management, and advanced settings -- all from the browser.

## Quick Start

```bash
nomos settings
```

This installs dependencies (first run only), starts a dev server on `http://localhost:3456`, and opens your browser.

To use a custom port:

```bash
nomos settings --port 4000
```

Press `Ctrl+C` to stop the server.

## Pages

### Root (`/`)

Server-side redirect based on setup status:

- If setup is incomplete (no API key or agent name) -> redirects to `/setup`
- If setup is complete -> redirects to `/dashboard`

### Setup Wizard (`/setup`)

A 5-step onboarding wizard for first-time setup:

1. **Database** -- enter PostgreSQL URL, test connection, run migrations. Offers Docker one-click setup command.
2. **API Provider** -- choose Anthropic API or Google Vertex AI. Validates the API key with a test call. Includes model selector.
3. **Identity** -- name your assistant, pick an emoji, set a purpose/personality, enter your name and timezone (auto-detected from browser).
4. **Channels** -- connect Slack, Discord, Telegram, Google Workspace, or WhatsApp with inline token inputs. Skip button for later.
5. **Ready** -- summary of what's configured, with "Go to Dashboard" and "Go to Settings" buttons.

The wizard stores all config in the database (encrypted for secrets). The CLI wizard (`nomos` with no `.env`) automatically launches this web wizard.

### Dashboard (`/dashboard`)

Overview with:

- **Status cards** -- assistant name/emoji, model, number of active channels, memory chunk count
- **Quick actions** -- "Connect a Channel", "Customize Personality", "View Memory"

### Assistant Settings (`/settings`)

- **Identity** section -- name, emoji, purpose textarea (stored in DB `config` table)
- **Anthropic API** -- API key input (stored encrypted in `integrations` table)
- **Google Cloud / Vertex AI** -- toggle, project ID, region selector
- **Model Configuration**:
  - Default model dropdown (Opus, Sonnet, Haiku)
  - Smart model routing toggle -- when enabled, shows per-tier model selectors:
    - Simple queries (greetings, lookups) -- defaults to Haiku
    - Moderate queries (general tasks) -- defaults to Sonnet
    - Complex queries (coding, reasoning) -- defaults to Sonnet
  - Custom API base URL -- point to Ollama + LiteLLM, Bedrock, or any Anthropic-compatible proxy
- **Multi-Agent Teams** -- team mode toggle + max parallel workers input. When enabled, `/team` prefix triggers task decomposition across parallel worker agents.
- **Adaptive Memory** -- toggle to enable knowledge extraction and user model learning. When enabled, shows extraction model selector (defaults to Haiku for cost efficiency). The agent will extract facts, preferences, and corrections from conversations and build a persistent user model.
- **Advanced Settings** (collapsed by default) -- permission mode, daemon port

### Channel Pages (`/integrations/*`)

| Route                    | Description                                              |
| ------------------------ | -------------------------------------------------------- |
| `/integrations`          | Overview cards showing status of all integrations        |
| `/integrations/slack`    | Slack workspace management (connect, test, disconnect)   |
| `/integrations/discord`  | Discord bot token, allowed channels/guilds               |
| `/integrations/telegram` | Telegram bot token, allowed chats                        |
| `/integrations/google`   | Google Workspace OAuth, service selection, multi-account |
| `/integrations/whatsapp` | WhatsApp toggle, allowed chats                           |

### Advanced (`/admin/*`)

| Route             | Description                                  |
| ----------------- | -------------------------------------------- |
| `/admin/database` | Database connection status, migration runner |
| `/admin/memory`   | Memory store stats, indexed sources          |

## Architecture

```
settings/
  src/
    app/
      layout.tsx                       Shell: sidebar + dark theme
      page.tsx                         Server redirect: /setup or /dashboard
      setup/
        page.tsx                       5-step wizard container
        layout.tsx                     Centered layout for wizard
        steps/
          database.tsx                 Step 1: Database connection
          api-key.tsx                  Step 2: API provider selection
          personality.tsx              Step 3: Name and personality
          channels.tsx                 Step 4: Connect channels
          ready.tsx                    Step 5: Summary
      dashboard/
        page.tsx                       Overview: status cards + quick actions
      settings/
        page.tsx                       Assistant identity + API config
      integrations/
        page.tsx                       Overview cards
        slack/page.tsx                 Slack workspace management
        discord/page.tsx               Discord config
        telegram/page.tsx              Telegram config
        google/page.tsx                Google Workspace OAuth + services
        whatsapp/page.tsx              WhatsApp config
      admin/
        database/page.tsx              DB status + migrations
        memory/page.tsx                Memory stats
      api/
        status/route.ts                GET integration status
        env/route.ts                   GET/PUT config (DB + .env fallback)
        config/route.ts                GET/PUT DB config keys (agent.*, user.*)
        setup/
          status/route.ts              GET onboarding completion check
          database/route.ts            POST test DB + run migrations
          validate-key/route.ts        POST validate API key
        slack/
          workspaces/route.ts          GET/POST/DELETE Slack workspaces
          test/route.ts                POST test Slack connection
        google/
          status/route.ts              GET Google status
          test/route.ts                POST test Google setup
          accounts/route.ts            GET/POST/DELETE Google accounts
          oauth/route.ts               OAuth callback handler
    components/
      sidebar.tsx                      Navigation (Dashboard, Assistant, Channels, Advanced)
      integration-card.tsx             Status card with quick actions
      status-badge.tsx                 Connected / Not configured badge
      token-input.tsx                  Masked token input with visibility toggle
      toast.tsx                        Toast notifications
      confirm-modal.tsx                Confirmation dialog
      dirty-indicator.tsx              Unsaved changes indicator
      daemon-status.tsx                Daemon connection status in sidebar footer
    lib/
      db.ts                            Postgres client (reads DATABASE_URL from env)
      env.ts                           Read/write parent .env file (fallback for DB)
      types.ts                         Shared TypeScript types
```

### Data Flow

```
Browser                     Next.js API Routes              PostgreSQL
  │                              │                              │
  │  GET /api/config             │                              │
  │─────────────────────────────>│  SELECT * FROM config        │
  │                              │─────────────────────────────>│
  │                              │<─────────────────────────────│
  │<─────────────────────────────│                              │
  │                              │                              │
  │  PUT /api/env                │                              │
  │  { ANTHROPIC_API_KEY: ... }  │                              │
  │─────────────────────────────>│  INSERT INTO integrations    │
  │                              │  (encrypted via AES-256-GCM) │
  │                              │─────────────────────────────>│
  │                              │                              │
  │                              │  Write to .env (secondary)   │
  │                              │─────────────────────────────>│ (filesystem)
  │<─────────────────────────────│                              │
```

### Config Storage

| What                              | Where                     | Encryption                    |
| --------------------------------- | ------------------------- | ----------------------------- |
| API keys, tokens                  | `integrations` table      | AES-256-GCM                   |
| Agent name, emoji, purpose        | `config` table            | No (not sensitive)            |
| Model, permission mode, ports     | `config` table / `.env`   | No                            |
| Smart routing, model tiers        | `config` table / `.env`   | No                            |
| Team mode, max workers            | `config` table / `.env`   | No                            |
| Custom API base URL               | `config` table / `.env`   | No                            |
| Adaptive memory, extraction model | `config` table / `.env`   | No                            |
| Slack workspaces                  | `slack_user_tokens` table | No (tokens in `integrations`) |

### Security Notes

- The settings UI is a **local-only** tool. It binds to `localhost`.
- Secrets are encrypted in the database via `ENCRYPTION_KEY` (auto-generated at `~/.nomos/encryption.key`).
- Tokens are masked in GET responses (first 8 chars + `***`).
- `.env` writes are restricted to a predefined allowlist of keys.

## Tech Stack

- **Next.js 15** (App Router) with **React 19**
- **Tailwind CSS v4** with Catppuccin Mocha theme
- **postgres** (same driver as the main app)
- **@slack/web-api** (connection testing)
- **lucide-react** (icons)
