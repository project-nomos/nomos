# Telegram Integration

Connect Nomos to Telegram so it can respond to private messages and group chat mentions.

## Prerequisites

- A Telegram account
- The Nomos daemon running (`pnpm daemon:dev` or `nomos daemon start`)

## Step 1: Create a Bot with BotFather

1. Open Telegram and search for [@BotFather](https://t.me/BotFather)
2. Send `/newbot`
3. Follow the prompts:
   - **Name:** Choose a display name (e.g., "Nomos")
   - **Username:** Choose a unique username ending in `bot` (e.g., `my_nomos_bot`)
4. BotFather will reply with your bot token — copy it

The token looks like: `123456789:ABCdefGHIjklMNOpqrsTUVwxyz`

## Step 2: Configure Environment Variables

Add the token to your `.env` file in the `nomos/` directory:

```bash
TELEGRAM_BOT_TOKEN=123456789:ABCdefGHIjklMNOpqrsTUVwxyz
```

### Optional: Restrict to Specific Chats

Limit the bot to certain users or groups:

```bash
TELEGRAM_ALLOWED_CHATS=123456789,-987654321
```

- **Positive numbers** are user/private chat IDs
- **Negative numbers** are group chat IDs

To find a chat ID: send a message to the bot, then open `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates` in a browser. Look for `"chat":{"id":...}` in the response.

## Step 3: Configure Bot Settings (Optional)

You can customize your bot through BotFather:

### Set a Description

```
/setdescription
```

Enter a description shown when users open the bot profile.

### Set Bot Commands

```
/setcommands
```

Add a command list for the bot's menu button (optional — the bot responds to freeform text).

### Disable Privacy Mode (For Groups)

By default, bots in group chats only receive messages that:

- Mention the bot with `@username`
- Are replies to the bot's messages
- Start with a `/command`

To let the bot see all group messages:

```
/setprivacy
```

Select the bot and choose **Disable**.

> **Note:** The bot must be removed and re-added to the group after changing this setting.

## Step 4: Start the Daemon

```bash
# Development mode (foreground with logs)
pnpm daemon:dev

# Or production mode (background)
nomos daemon start
```

You should see output confirming the Telegram adapter started:

```
[telegram-adapter] Running (bot: @my_nomos_bot)
[gateway]   Channels: telegram
```

## Usage

### Private Chats

Open a chat with your bot in Telegram and send any message. The bot responds to all private messages.

### Group Chats

1. Add the bot to a group
2. Mention it with `@your_bot_username <your message>`

If privacy mode is disabled, the bot can see all messages in the group.

### Typing Indicator

The bot shows a "typing..." indicator while processing your message.

## Message Limits

Telegram has a 4,096-character message limit. Long responses are automatically split into multiple messages at natural break points.

## MCP Tools

When `TELEGRAM_BOT_TOKEN` is set, the agent also gets access to Telegram MCP tools:

| Tool                      | Description                                     |
| ------------------------- | ----------------------------------------------- |
| `telegram_send_message`   | Send text messages (supports Markdown and HTML) |
| `telegram_edit_message`   | Edit previously sent messages                   |
| `telegram_delete_message` | Delete messages                                 |
| `telegram_send_photo`     | Send photos (URL or file path, max 10MB)        |
| `telegram_send_document`  | Send documents/files (max 50MB)                 |
| `telegram_send_location`  | Send GPS coordinates                            |
| `telegram_chat_info`      | Get chat details (type, title, description)     |
| `telegram_member_info`    | Get member status and info                      |
| `telegram_send_typing`    | Show typing indicator                           |
| `telegram_bot_info`       | Get bot details                                 |

### Message Formatting

The bot supports two formatting modes:

**Markdown:**

```
*bold*  _italic_  `code`  [link](https://example.com)
```

**HTML:**

```html
<b>bold</b> <i>italic</i> <code>code</code> <a href="https://example.com">link</a>
```

## Rate Limits

Telegram enforces:

- ~30 messages per second globally
- ~1 message per second per chat
- ~20 messages per minute in groups

The adapter handles these limits automatically.

## Troubleshooting

### Bot doesn't respond to private messages

- Verify `TELEGRAM_BOT_TOKEN` is set correctly
- Check daemon logs for errors
- Try sending `/start` to the bot first
- Make sure the daemon is running (`nomos daemon status`)

### Bot doesn't respond in groups

- Make sure the bot has been added to the group
- Mention the bot with `@username` in your message
- If you want the bot to see all messages, disable privacy mode via BotFather (`/setprivacy` > Disable), then remove and re-add the bot to the group

### "Unauthorized" or "Not Found" errors

- The token may have been revoked — generate a new one with `/token` in BotFather
- Make sure you copied the complete token including the number prefix

### Bot stops responding after a while

The adapter uses long polling and automatically reconnects on disconnections. If the bot stops responding:

- Check if the daemon process is still running
- Look for error messages in the daemon logs
- Restart the daemon: `nomos daemon restart`
