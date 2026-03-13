---
name: discord
description: "Interact with Discord — send messages, embeds, react, manage threads, pins, search, and look up members. Use when the user asks to send a Discord message, react, read channels, create threads, or manage Discord content. Requires DISCORD_BOT_TOKEN to be configured in .env."
emoji: "🎮"
---

# Discord

Interact with Discord using the built-in MCP tools provided by the `nomos-discord` server. These tools call the Discord REST API directly — no curl commands or shell environment variables needed.

## Available Tools

### Messaging

| Tool                     | Description                                           |
| ------------------------ | ----------------------------------------------------- |
| `discord_send_message`   | Send a text message to a channel or thread            |
| `discord_send_embed`     | Send a rich embed (title, description, color, footer) |
| `discord_edit_message`   | Edit an existing message                              |
| `discord_delete_message` | Delete a message                                      |

### Reading & Search

| Tool                   | Description                                               |
| ---------------------- | --------------------------------------------------------- |
| `discord_read_channel` | Read recent messages from a channel or thread             |
| `discord_search`       | Search messages in a guild by content, author, or channel |

### Reactions & Pins

| Tool                    | Description                       |
| ----------------------- | --------------------------------- |
| `discord_react`         | Add a reaction emoji to a message |
| `discord_pin_message`   | Pin a message                     |
| `discord_unpin_message` | Unpin a message                   |
| `discord_list_pins`     | List pinned messages in a channel |

### Threads

| Tool                    | Description                                              |
| ----------------------- | -------------------------------------------------------- |
| `discord_create_thread` | Create a thread from a message or as a standalone thread |

### Info

| Tool                    | Description                                                             |
| ----------------------- | ----------------------------------------------------------------------- |
| `discord_list_channels` | List all channels in a guild (text, voice, category, forum, etc.)       |
| `discord_member_info`   | Get details about a guild member (username, nickname, roles, join date) |

## Usage Examples

### Send a message

Use `discord_send_message` with a channel ID and content text.

### Send a rich embed

Use `discord_send_embed` for formatted announcements or status updates. Supports title, description (markdown), color (decimal integer), and footer.

Common colors: green = 5763719, red = 15548997, blue = 3447003, yellow = 16705372, purple = 10181046.

### Read channel history

Use `discord_read_channel` with a channel or thread ID. Returns messages with timestamps, IDs, and usernames.

### Create a thread

Use `discord_create_thread` with a channel ID and name. Optionally attach it to an existing message with `message_id`.

### Search messages

Use `discord_search` with a guild ID. Filter by content text, author ID, or channel ID.

### Find a channel

Use `discord_list_channels` with a guild ID to discover channel IDs, names, and types.

## Writing Style (Discord)

- Short, conversational, low ceremony.
- Avoid Markdown tables — Discord renders them poorly.
- Mention users as `<@USER_ID>`, channels as `<#CHANNEL_ID>`, roles as `<@&ROLE_ID>`.
- Use Discord markdown: `**bold**`, `*italic*`, `> quote`, `` `code` ``, ` ```codeblock``` `.
- Embeds support richer formatting than plain messages.

## Autonomous Discord Monitoring

Nomos can autonomously monitor Discord channels in the background using the daemon. When a user asks you to "watch my Discord", "monitor channels", or "listen for messages", **take action directly** — don't just show commands, run them yourself:

1. Check if the daemon is running: `nomos daemon status`
2. If not running, start it: `nomos daemon start` — it connects to Discord automatically when `DISCORD_BOT_TOKEN` is configured
3. Check current cron jobs: `nomos cron list`
4. Create a custom monitoring loop for periodic checks: `nomos cron create discord-watch "*/15 * * * *" --prompt "<instructions>"`

**Always execute these commands yourself using Bash** rather than telling the user to run them. If a command is blocked by permission hooks, show the user the exact command so they can run it. Confirm what you did after.

## Tips

- **Snowflake IDs**: all Discord IDs are large integers as strings
- **Channel types**: 0=text, 2=voice, 4=category, 5=announcement, 11=public-thread, 12=private-thread, 13=stage, 15=forum
- **Rate limits**: 5 req/5sec per route. The tools handle errors automatically.
- **Required bot permissions**: `SEND_MESSAGES`, `READ_MESSAGE_HISTORY`, `ADD_REACTIONS`, `MANAGE_MESSAGES`, `MANAGE_THREADS`, `CREATE_PUBLIC_THREADS`
- **Bot invite URL**: `https://discord.com/api/oauth2/authorize?client_id={CLIENT_ID}&permissions={PERMS}&scope=bot`
