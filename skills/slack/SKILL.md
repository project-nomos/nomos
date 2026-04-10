---
name: slack
description: "Interact with Slack workspaces — send messages, react, pin/unpin, read history, manage threads, search, upload files, and look up members. Use when the user asks to send a Slack message, react to something, read a channel, or manage Slack content."
emoji: "💬"
---

# Slack

Interact with Slack using the built-in MCP tools provided by the `nomos-slack` server. These tools call the Slack Web API directly — no curl commands or shell environment variables needed.

## Available Tools

### Messaging

| Tool                   | Description                           |
| ---------------------- | ------------------------------------- |
| `slack_send_message`   | Send a message to a channel or thread |
| `slack_edit_message`   | Edit an existing message              |
| `slack_delete_message` | Delete a message                      |

### Reading

| Tool                 | Description                                                              |
| -------------------- | ------------------------------------------------------------------------ |
| `slack_read_channel` | Read recent messages from a channel                                      |
| `slack_read_thread`  | Read replies in a thread                                                 |
| `slack_search`       | Search messages by keyword (supports `in:#channel`, `from:@user` syntax) |

### Reactions & Pins

| Tool                  | Description                       |
| --------------------- | --------------------------------- |
| `slack_react`         | Add a reaction emoji to a message |
| `slack_pin_message`   | Pin a message                     |
| `slack_unpin_message` | Unpin a message                   |
| `slack_list_pins`     | List pinned items in a channel    |

### Info & Files

| Tool                  | Description                                              |
| --------------------- | -------------------------------------------------------- |
| `slack_list_channels` | List channels the bot can see                            |
| `slack_user_info`     | Get details about a user (name, email, status, timezone) |
| `slack_upload_file`   | Upload a local file to a channel                         |

## Usage Examples

### Send a message

Use `slack_send_message` with the channel ID and text. For threaded replies, include `thread_ts`.

### Read a channel

Use `slack_read_channel` with the channel ID. Returns messages in chronological order with timestamps, user IDs, and reaction counts.

### Reply in a thread

Use `slack_send_message` with `thread_ts` set to the parent message timestamp.

### Search for messages

Use `slack_search` with Slack search syntax:

- `release notes` — search all channels
- `in:#engineering release notes` — search a specific channel
- `from:@alice bug report` — search messages from a user

### Find a channel

Use `slack_list_channels` to get channel IDs and names. Use the ID in subsequent tool calls.

### Look up a user

Use `slack_user_info` with a user ID (e.g. from a message) to get their name, email, status, and timezone.

## Listening as the User

Nomos can listen to Slack **as the user personally** — not as a bot. It responds to DMs and @mentions using the user's own token, so messages appear as if the user typed them.

When a user asks you to "listen to my Slack", "respond as me", or "act as me on Slack", **take action directly**:

1. Check if a workspace is connected: `nomos slack workspaces`
2. If no workspaces, tell the user to connect one: `nomos slack auth --token xoxp-...`
3. Start the listener: `nomos slack listen`

**Always execute these commands yourself using Bash** rather than telling the user to run them. If a command is blocked by permission hooks, show the user the exact command so they can run it. Confirm what you did after.

## Autonomous Slack Monitoring

Nomos can also autonomously monitor Slack channels in the background using the daemon and autonomous loops. When a user asks you to "watch my channels" or "monitor messages in the background", **take action directly**:

1. Check if the daemon is running: `nomos daemon status`
2. If not running, start it: `nomos daemon start`
3. Check current cron jobs: `nomos cron list`
4. Enable the built-in `slack-digest` loop (runs every 30 min, scans channels for messages needing attention): `nomos cron enable slack-digest`
5. If the user wants more specific monitoring, create a custom loop: `nomos cron create <name> "<schedule>" --prompt "<instructions>"`

**Always execute these commands yourself using Bash** rather than telling the user to run them. If a command is blocked by permission hooks, show the user the exact command so they can run it. Confirm what you did after.

The daemon connects to Slack via Socket Mode and listens in real-time. Autonomous loops add proactive periodic checks on top of that. Together, they ensure no important message goes unnoticed.

## Tips

- **Channel IDs**: `C` prefix = public, `G` = private/group, `D` = DM
- **User IDs**: `U` or `W` prefix
- **Timestamps** (`ts`): uniquely identify messages — used for threading, reactions, pins, editing, and deleting
- **Formatting**: Slack uses mrkdwn — `*bold*`, `_italic_`, `~strikethrough~`, `` `code` ``, ` ```code block``` `, `<url|link text>`
- **Mentions**: `<@U01ABCDEF>` for users, `<#C01ABCDEF>` for channels
- **Rate limits**: Slack applies per-method rate limits (~1 req/sec for most). The tools handle errors automatically.
- **Required bot scopes**: `chat:write`, `channels:read`, `channels:history`, `groups:read`, `groups:history`, `users:read`, `reactions:write`, `pins:write`, `files:write`, `search:read`
