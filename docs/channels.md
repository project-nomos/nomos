# Channel Integrations

Nomos connects to 6 messaging platforms through thin adapter modules (~50-100 LOC each). All agent logic is centralized in `AgentRuntime`; adapters just route messages in and responses out. Each adapter registers automatically when its required environment variables are present.

## Quick Setup Reference

### Slack (Bot Mode)

```bash
SLACK_BOT_TOKEN=xoxb-...          # Bot User OAuth Token
SLACK_APP_TOKEN=xapp-...          # App-Level Token (Socket Mode)
SLACK_ALLOWED_CHANNELS=C123,C456  # Optional: restrict to specific channels
```

See [slack.md](integrations/slack.md) for full setup including app creation and permissions.

### Slack (User Mode)

Nomos can also operate as you — drafting responses to your DMs for approval, then sending as the authenticated user. Supports multi-workspace via OAuth.

```bash
npx nomos-slack-add-workspace     # Interactive OAuth or manual token
```

Uses [`nomos-slack-mcp`](https://github.com/project-nomos/nomos-slack-mcp) for channel/user name resolution, message formatting, search, reactions, and multi-workspace support. See [slack-user-mode.md](integrations/slack-user-mode.md) for details.

### Discord

```bash
DISCORD_BOT_TOKEN=...                     # Bot token from Discord Developer Portal
DISCORD_ALLOWED_CHANNELS=123456,789012    # Optional: restrict to specific channels
```

See [discord.md](integrations/discord.md) for bot creation and permissions.

### Telegram

```bash
TELEGRAM_BOT_TOKEN=...                    # Token from @BotFather
TELEGRAM_ALLOWED_CHATS=123456,-789012     # Optional: restrict to specific chats
```

See [telegram.md](integrations/telegram.md) for setup.

### WhatsApp

```bash
WHATSAPP_ENABLED=true
WHATSAPP_ALLOWED_CHATS=15551234567@s.whatsapp.net
```

Uses Baileys with QR code auth (no Meta Business API required). Auth state persisted to `~/.nomos/whatsapp-auth/`. See [whatsapp.md](integrations/whatsapp.md) for setup.

### iMessage (macOS only)

Read-only bridge that reads from the macOS Messages.app SQLite database. See [imessage.md](integrations/imessage.md) for setup.

## Data Integrations (via MCP)

These integrations connect via external MCP servers and provide tools for the agent to use.

| Integration          | MCP Server                                                               | Guide                                     |
| -------------------- | ------------------------------------------------------------------------ | ----------------------------------------- |
| **Google Ads**       | [google-ads-mcp](https://github.com/googleads/google-ads-mcp)            | [Setup](integrations/google-ads.md)       |
| **Google Analytics** | [analytics-mcp](https://github.com/googleanalytics/google-analytics-mcp) | [Setup](integrations/google-analytics.md) |
| **Google Workspace** | [@googleworkspace/cli](https://github.com/googleworkspace/cli)           | [Setup](integrations/google-workspace.md) |

## Architecture

Each channel adapter implements a common interface:

1. **Registration** — adapter checks for required env vars at startup and registers with `ChannelManager`
2. **Message intake** — incoming messages are normalized into a common format and enqueued per-session
3. **Response delivery** — agent responses stream back through `StreamingResponder` for progressive message updates (Slack and Discord) or single-message delivery (Telegram, WhatsApp)
4. **Session scoping** — each channel uses configurable session scope modes: per-sender, per-peer, per-channel, or per-channel-peer

### Pairing System

Channels support an 8-character pairing code system with TTL for access control. Users can generate a pairing code via the CLI or web UI, then enter it in a channel to link their identity and grant access.

### Proactive Messaging

The agent can send outbound messages to any connected channel outside the normal reply flow. This enables notifications, scheduled reports, and inter-agent messaging across platforms.
