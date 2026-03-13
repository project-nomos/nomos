---
name: telegram
description: "Interact with Telegram — send messages, photos, documents, locations, edit and delete messages, get chat and member info. Use when the user asks to send a Telegram message, edit content, send media, or manage Telegram chats. Requires TELEGRAM_BOT_TOKEN to be configured in .env."
emoji: "📱"
---

# Telegram

Interact with Telegram using the built-in MCP tools provided by the `nomos-telegram` server. These tools call the Telegram Bot API directly — no curl commands or shell environment variables needed.

## Available Tools

### Messaging

| Tool                      | Description                                                 |
| ------------------------- | ----------------------------------------------------------- |
| `telegram_send_message`   | Send a text message (supports Markdown and HTML formatting) |
| `telegram_edit_message`   | Edit an existing message                                    |
| `telegram_delete_message` | Delete a message                                            |

### Media

| Tool                     | Description                                                 |
| ------------------------ | ----------------------------------------------------------- |
| `telegram_send_photo`    | Send a photo from URL or local file (with optional caption) |
| `telegram_send_document` | Send a document/file from URL or local file                 |
| `telegram_send_location` | Send a geographic location                                  |

### Info

| Tool                   | Description                                                   |
| ---------------------- | ------------------------------------------------------------- |
| `telegram_chat_info`   | Get details about a chat (type, title, username, description) |
| `telegram_member_info` | Get details about a chat member (status, username)            |
| `telegram_bot_info`    | Get information about the bot itself                          |

### Utility

| Tool                   | Description                                             |
| ---------------------- | ------------------------------------------------------- |
| `telegram_send_typing` | Send a typing indicator (shows "typing..." in the chat) |

## Usage Examples

### Send a message

Use `telegram_send_message` with a chat ID and text. Optionally set `parse_mode` to `"Markdown"` or `"HTML"` for formatting.

### Reply to a message

Use `telegram_send_message` with `reply_to_message_id` set to the original message ID.

### Send a formatted message

Markdown mode:

- `*bold*`, `_italic_`, `` `code` ``, ` ```code block``` `
- `[link text](url)`

HTML mode:

- `<b>bold</b>`, `<i>italic</i>`, `<code>code</code>`, `<pre>code block</pre>`
- `<a href="url">link text</a>`

### Send a photo

Use `telegram_send_photo` with a URL or local file path. Add a caption (max 1024 chars).

### Send a document

Use `telegram_send_document` with a URL or local file path.

### Get chat info

Use `telegram_chat_info` with a chat ID to see the chat type, title, and description.

## Tips

- **Chat IDs**: positive = users, negative = groups/channels
- **Message IDs**: unique within a chat (integers, not timestamps)
- **Message length limit**: 4096 characters per message
- **Photo captions**: max 1024 characters
- **File size limits**: photos 10MB, documents 50MB
- **Formatting**: set `parse_mode` to `"Markdown"` or `"HTML"` — if omitted, no formatting is applied
- **Groups**: bots only see messages that mention them unless privacy mode is disabled
- **Rate limits**: ~30 msg/sec globally, ~1 msg/sec per chat. The tools handle errors automatically.
- **Bot management**: use `@BotFather` on Telegram to create and configure bots
