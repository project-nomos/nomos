# Slack Integration

Connect Nomos to Slack so it can respond to DMs and @mentions in channels. Messages stream in real-time — users see a "_Thinking..._" indicator followed by progressive text updates, just like ChatGPT's Slack bot.

## Prerequisites

- A Slack workspace where you have permission to install apps
- The Nomos daemon running (`pnpm daemon:dev` or `nomos daemon start`)

## Step 1: Create a Slack App

1. Go to [https://api.slack.com/apps](https://api.slack.com/apps)
2. Click **Create New App** > **From scratch**
3. Enter a name (e.g., "Nomos") and select your workspace
4. Click **Create App**

## Step 2: Enable Socket Mode

Socket Mode lets the bot connect without exposing a public URL.

1. In the app settings sidebar, go to **Socket Mode**
2. Toggle **Enable Socket Mode** to On
3. You'll be prompted to create an App-Level Token:
   - Name it `socket-token`
   - Add the scope `connections:write`
   - Click **Generate**
4. Copy the token (starts with `xapp-`) — this is your `SLACK_APP_TOKEN`

## Step 3: Configure Bot Scopes

1. Go to **OAuth & Permissions** in the sidebar
2. Scroll to **Scopes** > **Bot Token Scopes**
3. Add the following scopes:

| Scope              | Purpose                           |
| ------------------ | --------------------------------- |
| `chat:write`       | Send and update messages          |
| `channels:read`    | List public channels              |
| `channels:history` | Read messages in public channels  |
| `groups:read`      | List private channels             |
| `groups:history`   | Read messages in private channels |
| `im:history`       | Read direct messages              |
| `im:read`          | View DM metadata                  |
| `im:write`         | Send direct messages              |
| `users:read`       | Look up user names and details    |
| `reactions:write`  | Add emoji reactions               |
| `pins:write`       | Pin and unpin messages            |
| `files:write`      | Upload files                      |
| `search:read`      | Search workspace messages         |

## Step 4: Enable App Home & Direct Messages

This step is required for users to DM the bot. Without it, Slack shows "Sending messages to this app has been turned off."

1. Go to **App Home** in the sidebar
2. Scroll to **Show Tabs**
3. Check **Messages Tab**
4. Enable the checkbox **"Allow users to send Slash commands and messages from the messages tab"**

## Step 5: Enable Event Subscriptions

1. Go to **Event Subscriptions** in the sidebar
2. Toggle **Enable Events** to On
3. Under **Subscribe to bot events**, add:
   - `app_mention` — triggers when the bot is @mentioned in a channel
   - `message.im` — triggers on direct messages to the bot
4. Click **Save Changes**

## Step 6: Install the App

After configuring scopes, App Home, and events, install (or reinstall) the app to apply the changes.

1. Go to **Install App** in the sidebar
2. Click **Install to Workspace** (or **Reinstall to Workspace** if already installed)
3. Review the permissions and click **Allow**
4. Copy the **Bot User OAuth Token** (starts with `xoxb-`) — this is your `SLACK_BOT_TOKEN`

> **Important:** Any time you change scopes, events, or App Home settings, you must reinstall the app for the changes to take effect.

## Step 7: Configure Environment Variables

Add the tokens to your `.env` file in the project root:

```bash
SLACK_BOT_TOKEN=xoxb-your-bot-token-here
SLACK_APP_TOKEN=xapp-your-app-token-here
```

### Optional: Restrict to Specific Channels

To limit the bot to certain channels, set a comma-separated list of channel IDs:

```bash
SLACK_ALLOWED_CHANNELS=C01ABC123,C02DEF456
```

To find a channel ID: right-click a channel in Slack > **View channel details** > the ID is at the bottom of the popup.

## Step 7: Start the Daemon

```bash
# Development mode (foreground with logs)
pnpm daemon:dev

# Or production mode (background)
nomos daemon start
```

You should see output confirming the Slack adapter started:

```
[slack-adapter] Running (bot: U0XXXXXX)
[gateway]   Channels: slack
```

## Usage

### Direct Messages

Send a DM to the bot — it responds to all messages in DMs automatically.

### Channel Mentions

In any channel the bot has been invited to, @mention it:

```
@Nomos what's the weather like today?
```

The bot must be invited to a channel before it can receive mentions there. Type `/invite @Nomos` in the channel.

### Threaded Conversations

All replies are posted in-thread. The bot maintains conversation context within each thread.

## Real-Time Streaming

When the bot processes a message in Slack:

1. A "_Thinking..._" placeholder appears immediately
2. As the agent generates text, the message updates every ~1.5 seconds
3. During tool use, you'll see indicators like "_Using Read..._"
4. The final complete response replaces the streaming content

For long responses (over 4,000 characters), the streaming message is replaced with properly chunked messages.

## MCP Tools

When `SLACK_BOT_TOKEN` is set, the agent also gets access to Slack MCP tools for proactive actions:

| Tool                   | Description                            |
| ---------------------- | -------------------------------------- |
| `slack_send_message`   | Send messages to any channel or thread |
| `slack_edit_message`   | Edit previously sent messages          |
| `slack_delete_message` | Delete messages                        |
| `slack_read_channel`   | Read recent messages (up to 100)       |
| `slack_read_thread`    | Read thread replies                    |
| `slack_react`          | Add emoji reactions                    |
| `slack_pin_message`    | Pin a message                          |
| `slack_unpin_message`  | Unpin a message                        |
| `slack_list_pins`      | List pinned items in a channel         |
| `slack_list_channels`  | List accessible channels               |
| `slack_user_info`      | Look up user details                   |
| `slack_upload_file`    | Upload files to channels               |
| `slack_search`         | Search workspace messages              |

These tools let the agent interact with Slack beyond just replying — it can search history, read other channels, pin important messages, and more.

## Troubleshooting

### "Sending messages to this app has been turned off"

This means the Messages Tab isn't enabled for the bot:

1. Go to your app settings > **App Home** > **Show Tabs**
2. Check **Messages Tab**
3. Enable **"Allow users to send Slash commands and messages from the messages tab"**
4. Go to **OAuth & Permissions** and confirm the `im:history`, `im:read`, and `im:write` scopes are added
5. Go to **Event Subscriptions** > **Subscribe to bot events** and confirm `message.im` is listed
6. **Reinstall the app** — go to **Install App** and click **Reinstall to Workspace**

All of these must be in place, and the app must be reinstalled after making changes.

### Bot doesn't respond to messages

- Verify both `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` are set correctly
- Check the daemon logs for connection errors
- Make sure `message.im` and `app_mention` events are subscribed
- For channel messages, ensure the bot is invited to the channel

### "not_in_channel" errors

The bot needs to be a member of any channel it posts to. Invite it with `/invite @Nomos`.

### Rate limiting

The streaming responder throttles updates to ~40/minute per conversation, well within Slack's Tier 3 limit of 50 requests/minute. If you see rate limit errors in logs, they're handled gracefully — the update is skipped and retried on the next interval.

### Socket Mode disconnections

Socket Mode automatically reconnects. If the bot appears offline, check:

- The `SLACK_APP_TOKEN` hasn't been revoked
- The app's Socket Mode setting is still enabled
- The daemon process is running (`nomos daemon status`)

## Slack User Mode

In addition to bot mode, Nomos supports **User Mode** — where it acts as you (the authenticated user) instead of as a bot. It listens to DMs and @mentions directed at your personal Slack account and responds using your user token so messages appear as if you typed them.

### Quick Start (CLI listener)

```bash
# Connect your workspace with a user token
nomos slack auth --token xoxp-your-token

# Start listening as you
nomos slack listen
```

The CLI listener sends responses directly. For unattended background use with draft approval, run via the daemon instead.

For full setup instructions, see [Slack User Mode](slack-user-mode.md).
