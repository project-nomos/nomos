# Discord Integration

Connect Nomos to Discord so it can respond to DMs and @mentions in server channels.

## Prerequisites

- A Discord server where you have the **Manage Server** permission
- The Nomos daemon running (`pnpm daemon:dev` or `nomos daemon start`)

## Step 1: Create a Discord Application

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
2. Click **New Application**
3. Enter a name (e.g., "Nomos") and click **Create**

## Step 2: Create a Bot User

1. In the application settings, go to **Bot** in the sidebar
2. Click **Add Bot** > **Yes, do it!**
3. Under the bot's username, click **Reset Token**
4. Copy the token — this is your `DISCORD_BOT_TOKEN`

> **Important:** This token is shown only once. Store it securely.

## Step 3: Enable Privileged Intents

Still on the **Bot** page, scroll to **Privileged Gateway Intents** and enable:

| Intent                     | Purpose                       |
| -------------------------- | ----------------------------- |
| **Message Content Intent** | Required to read message text |
| **Server Members Intent**  | Optional — for member lookups |

Click **Save Changes**.

## Step 4: Invite the Bot to Your Server

1. Go to **OAuth2** > **URL Generator** in the sidebar
2. Under **Scopes**, check `bot`
3. Under **Bot Permissions**, select:

| Permission            | Purpose                    |
| --------------------- | -------------------------- |
| Send Messages         | Reply to users             |
| Read Message History  | Read channel context       |
| Add Reactions         | React to messages          |
| Manage Messages       | Pin/unpin messages         |
| Manage Threads        | Create and manage threads  |
| Create Public Threads | Start thread conversations |

Or check **Administrator** for testing (not recommended for production).

4. Copy the generated URL at the bottom
5. Open the URL in your browser
6. Select the server and click **Authorize**

## Step 5: Configure Environment Variables

Add the token to your `.env` file in the `nomos/` directory:

```bash
DISCORD_BOT_TOKEN=your-bot-token-here
```

### Optional: Restrict Access

Limit the bot to specific channels or servers:

```bash
# Only respond in these channels (comma-separated channel IDs)
DISCORD_ALLOWED_CHANNELS=1234567890,0987654321

# Only respond in these servers (comma-separated guild IDs)
DISCORD_ALLOWED_GUILDS=1122334455
```

To find a channel or server ID: enable **Developer Mode** in Discord settings (under Advanced), then right-click a channel or server and select **Copy ID**.

## Step 6: Start the Daemon

```bash
# Development mode (foreground with logs)
pnpm daemon:dev

# Or production mode (background)
nomos daemon start
```

You should see output confirming the Discord adapter started:

```
[discord-adapter] Running (bot: Nomos#1234)
[gateway]   Channels: discord
```

## Usage

### Direct Messages

Send a DM to the bot — it responds to all direct messages automatically.

### Server Mentions

In any channel the bot has access to, @mention it:

```
@Nomos explain this error in our codebase
```

The bot must have permission to see and send messages in the channel.

### Conversation Context

Each channel maintains its own session, so the bot remembers context within a channel conversation.

## Message Limits

Discord has a 2,000-character message limit. Long responses are automatically split into multiple messages at natural break points (newlines or spaces).

## MCP Tools

When `DISCORD_BOT_TOKEN` is set, the agent also gets access to Discord MCP tools:

| Tool                     | Description                                             |
| ------------------------ | ------------------------------------------------------- |
| `discord_send_message`   | Send text messages to channels                          |
| `discord_send_embed`     | Send rich embeds with title, description, color, footer |
| `discord_edit_message`   | Edit previously sent messages                           |
| `discord_delete_message` | Delete messages                                         |
| `discord_read_channel`   | Read recent messages (up to 100)                        |
| `discord_react`          | Add emoji reactions (Unicode or custom)                 |
| `discord_pin_message`    | Pin a message                                           |
| `discord_unpin_message`  | Unpin a message                                         |
| `discord_list_pins`      | List pinned messages                                    |
| `discord_create_thread`  | Create threads from messages or standalone              |
| `discord_list_channels`  | List channels in a server                               |
| `discord_member_info`    | Get member details (username, roles, join date)         |
| `discord_search`         | Search messages by content, author, or channel          |

### Embed Colors

When using `discord_send_embed`, specify colors as decimal values:

| Color  | Value      |
| ------ | ---------- |
| Green  | `5763719`  |
| Red    | `15548997` |
| Blue   | `3447003`  |
| Yellow | `16705372` |
| Purple | `10181046` |

## Troubleshooting

### Bot doesn't respond to messages

- Verify `DISCORD_BOT_TOKEN` is set correctly
- Check that **Message Content Intent** is enabled in the Developer Portal
- Make sure the bot has Send Messages and Read Message History permissions in the channel
- Check daemon logs for connection errors

### "Missing Permissions" errors

The bot needs the correct permissions in each channel. Check:

- Server-level permissions (from the invite URL)
- Channel-level permission overrides (channel settings > Permissions)

### Bot appears offline

- Confirm the daemon is running (`nomos daemon status`)
- Check the token hasn't been regenerated in the Developer Portal
- The bot reconnects automatically after disconnections, but a revoked token requires updating `.env`

### "Disallowed intents" error

You need to enable **Message Content Intent** in the Developer Portal under Bot > Privileged Gateway Intents. This is required for the bot to read message content.
