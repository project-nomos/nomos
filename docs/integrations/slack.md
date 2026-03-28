# Slack Integration

Connect Nomos to Slack so it can respond to DMs and @mentions in channels, read messages, search history, and act as you across multiple workspaces. Messages stream in real-time — users see a "_Thinking..._" indicator followed by progressive text updates.

## Architecture

Nomos uses two components for Slack:

| Component           | Purpose                                                                                       | How it connects                   |
| ------------------- | --------------------------------------------------------------------------------------------- | --------------------------------- |
| **Nomos daemon**    | Listens for DMs/@mentions, responds in real-time (bot mode or user mode)                      | Socket Mode via `SLACK_APP_TOKEN` |
| **nomos-slack-mcp** | Gives the agent proactive Slack tools (read channels, send messages, search, reactions, etc.) | External MCP server over stdio    |

Both can work independently or together. The daemon handles real-time messaging; `nomos-slack-mcp` gives the agent tools to interact with Slack proactively.

## Quick Start

### Option A: App Manifest (recommended)

Import the included manifest to create a pre-configured Slack app:

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From an app manifest**
2. Select your workspace
3. Paste the contents of [`slack-app-manifest.yaml`](../../slack-app-manifest.yaml) (or `.json`)
4. Review and click **Create**

> **Note:** The manifest includes a placeholder redirect URL (`https://your-domain.com/slack/oauth/callback`). If you plan to distribute the app to multiple workspaces via OAuth, replace it with your actual HTTPS URL. For local-only use, you can remove the redirect URL entirely.

5. Go to **Basic Information** → **App-Level Tokens** → generate a token with `connections:write` scope — this is your `SLACK_APP_TOKEN` (`xapp-...`)
6. Go to **Install App** → install to your workspace → copy the **Bot User OAuth Token** (`xoxb-...`) — this is your `SLACK_BOT_TOKEN`

### Option B: Manual Setup

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From scratch**
2. Follow Steps 1-6 below to configure scopes, events, and Socket Mode

## Step 1: Enable Socket Mode

1. In the app settings sidebar, go to **Socket Mode**
2. Toggle **Enable Socket Mode** to On
3. Create an App-Level Token:
   - Name it `socket-token`
   - Add the scope `connections:write`
   - Click **Generate**
4. Copy the token (`xapp-...`) — this is your `SLACK_APP_TOKEN`

## Step 2: Configure Bot Scopes

1. Go to **OAuth & Permissions** → **Bot Token Scopes**
2. Add:

| Scope               | Purpose                           |
| ------------------- | --------------------------------- |
| `app_mentions:read` | Receive @mention events           |
| `channels:history`  | Read messages in public channels  |
| `channels:read`     | List public channels              |
| `chat:write`        | Send and update messages          |
| `files:write`       | Upload files                      |
| `groups:history`    | Read messages in private channels |
| `groups:read`       | List private channels             |
| `im:history`        | Read direct messages              |
| `im:read`           | View DM metadata                  |
| `im:write`          | Send direct messages              |
| `pins:write`        | Pin and unpin messages            |
| `reactions:write`   | Add emoji reactions               |
| `users:read`        | Look up user names                |

## Step 3: Enable App Home & Direct Messages

1. Go to **App Home** → **Show Tabs**
2. Check **Messages Tab**
3. Enable **"Allow users to send Slash commands and messages from the messages tab"**

## Step 4: Enable Event Subscriptions

1. Go to **Event Subscriptions** → toggle **Enable Events** to On
2. Under **Subscribe to bot events**, add:
   - `app_mention`
   - `message.im`
3. Click **Save Changes**

## Step 5: Install the App

1. Go to **Install App** → **Install to Workspace**
2. Copy the **Bot User OAuth Token** (`xoxb-...`) — this is your `SLACK_BOT_TOKEN`

> Any time you change scopes or events, you must reinstall the app.

## Step 6: Configure

Add tokens to `~/.nomos/.env` (or via Settings UI at `localhost:3456/integrations/slack`):

```bash
SLACK_APP_TOKEN=xapp-...    # App-Level Token (Socket Mode)
SLACK_BOT_TOKEN=xoxb-...    # Bot User OAuth Token
```

### Optional: Restrict to Specific Channels

```bash
SLACK_ALLOWED_CHANNELS=C01ABC123,C02DEF456
```

## Step 7: Start the Daemon

```bash
nomos daemon start
# or development mode:
pnpm daemon:dev
```

You should see:

```
[slack-adapter] Running (bot: U0XXXXXX)
[gateway]   Channels: slack
```

## Multi-Workspace Support

Nomos supports connecting to multiple Slack workspaces simultaneously. Each workspace gets its own user token (`xoxp-`) stored encrypted in the database.

### Adding Workspaces

There are three ways to connect a workspace:

#### Option A: Via `nomos-slack-mcp` OAuth (recommended for multi-workspace)

```bash
npx nomos-slack-mcp add-workspace
```

This opens a browser for OAuth authorization. The token is stored in `~/.nomos/slack/config.json`. On the next daemon start (or workspace add via Settings UI/CLI), tokens are synced to the database.

> **Note:** Multi-workspace OAuth requires your Slack app to have [distribution enabled](#enabling-distribution). For your home workspace only, distribution is not needed.

#### Option B: Manual token

If you already have a `xoxp-` user token:

```bash
nomos slack auth --token xoxp-...
```

Or via the Settings UI: **Integrations → Slack → Manual Token** section. This works for any workspace without distribution.

#### Option C: Settings UI OAuth

Authorize workspaces directly from the Settings UI:

1. Configure `SLACK_CLIENT_ID` and `SLACK_CLIENT_SECRET` in **App Configuration**
2. Click **Authorize Workspace**

> Multi-workspace requires [distribution enabled](#enabling-distribution).

### Enabling Distribution

To connect workspaces other than your home workspace via OAuth (Options A or C), your Slack app must have distribution enabled:

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → your app → **OAuth & Permissions** → **Redirect URLs**
2. Add an HTTPS redirect URL (e.g., `https://your-domain.com/slack/oauth/callback`)
3. Go to **Manage Distribution**
4. Check **"Remove Hard Coded Information"**
5. Click **Activate Public Distribution**

> Slack requires HTTPS for distributed apps. If you don't have an HTTPS endpoint, use Option B (manual token) — you can generate user tokens from the **OAuth & Permissions** page for each workspace where the app is installed.

### Managing Workspaces

```bash
nomos slack workspaces       # List all connected workspaces
nomos slack remove T01ABC    # Disconnect a workspace
```

### How Tokens Are Stored

- **Database** (source of truth) — tokens encrypted at rest via AES-256-GCM in the `integrations` table
- **Config file** (runtime sync) — `~/.nomos/slack/config.json` is auto-synced from DB for `nomos-slack-mcp` to read
- Tokens are synced whenever workspaces are added/removed and on daemon startup

## nomos-slack-mcp Tools

When `nomos-slack-mcp` is configured (workspaces in DB or `~/.nomos/slack/config.json`), the agent gets proactive Slack tools:

| Tool                                        | Description                            |
| ------------------------------------------- | -------------------------------------- |
| `slack_read_channel`                        | Read recent messages (up to 100)       |
| `slack_read_thread`                         | Read thread replies                    |
| `slack_send_message`                        | Send messages to any channel or thread |
| `slack_edit_message`                        | Edit previously sent messages          |
| `slack_delete_message`                      | Delete messages                        |
| `slack_search`                              | Search workspace messages              |
| `slack_list_channels`                       | List accessible channels               |
| `slack_user_info`                           | Look up user details                   |
| `slack_react`                               | Add emoji reactions                    |
| `slack_pin_message` / `slack_unpin_message` | Pin/unpin messages                     |
| `slack_list_pins`                           | List pinned items                      |
| `slack_upload_file`                         | Upload files to channels               |
| `slack_set_status`                          | Set your Slack status                  |

These tools work with multi-workspace — each tool accepts an optional `workspace` parameter to target a specific workspace.

## User Mode

In addition to bot mode, Nomos supports **User Mode** — it acts as you instead of as a bot. Messages appear as if you typed them.

```bash
# Connect a workspace
nomos slack auth --token xoxp-...

# Start listening as you
nomos slack listen
```

For full details including draft approval, daemon integration, and required scopes, see [Slack User Mode](slack-user-mode.md).

## Real-Time Streaming

When the bot processes a message:

1. A "_Thinking..._" placeholder appears immediately
2. As the agent generates text, the message updates every ~1.5 seconds
3. During tool use, you'll see indicators like "_Using Read..._"
4. The final complete response replaces the streaming content

For long responses (over 4,000 characters), the streaming message is replaced with properly chunked messages.

## Troubleshooting

### "Sending messages to this app has been turned off"

1. Go to **App Home** → check **Messages Tab** + **"Allow users to send..."**
2. Confirm `im:history`, `im:read`, `im:write` scopes are added
3. Confirm `message.im` is in bot events
4. **Reinstall the app**

### Bot doesn't respond to messages

- Verify both `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` are set
- Check daemon logs for connection errors
- For channel messages, invite the bot: `/invite @Nomos`

### "not_in_channel" errors

The bot must be a member of the channel. Invite it with `/invite @Nomos`.

### "invalid_team_for_non_distributed_app"

Your Slack app isn't enabled for multi-workspace distribution. Either:

- Enable distribution: **Manage Distribution** → **Activate Public Distribution** (requires HTTPS redirect URL)
- Or use `npx nomos-slack-mcp add-workspace` instead (no distribution needed)

### Socket Mode disconnections

Socket Mode auto-reconnects. If the bot appears offline:

- Check that `SLACK_APP_TOKEN` hasn't been revoked
- Verify Socket Mode is still enabled in app settings
- Confirm the daemon is running: `nomos daemon status`
