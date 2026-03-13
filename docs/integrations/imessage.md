# iMessage Integration

Connect Nomos to iMessage on macOS. The adapter reads incoming messages from the local Messages database and sends replies via AppleScript, enabling two-way conversations with individuals and group chats.

> **macOS only.** This integration relies on the Messages app and its local SQLite database, which are only available on macOS.

## Prerequisites

- macOS with Messages.app signed into iMessage
- Messages.app running (it must stay open)
- **Full Disk Access** granted to your terminal app (for reading `~/Library/Messages/chat.db`)
- **Automation** permission for `osascript` to control Messages.app
- The Nomos daemon running (`pnpm daemon:dev` or `nomos daemon start`)

## Step 1: Grant Permissions

### Full Disk Access

The adapter reads `~/Library/Messages/chat.db` to detect incoming messages. macOS restricts access to this file.

1. Open **System Settings** > **Privacy & Security** > **Full Disk Access**
2. Click the **+** button
3. Add your terminal application (e.g., Terminal.app, iTerm2, Alacritty, VS Code)
4. Restart the terminal after granting access

### Automation Permission

The adapter sends messages via AppleScript (`osascript`). The first time a message is sent, macOS will prompt you to allow your terminal to control Messages.app. Click **OK** to grant the permission.

You can verify or change this at **System Settings** > **Privacy & Security** > **Automation**.

## Step 2: Enable iMessage

Add this to your `.env` file:

```bash
IMESSAGE_ENABLED=true
```

### Optional: Restrict to Specific Contacts or Groups

Limit the bot to certain contacts or group chats:

```bash
IMESSAGE_ALLOWED_CHATS=+15551234567,user@example.com,chat123456789
```

Comma-separated list. Accepts:

- **Phone numbers**: `+15551234567` (international format with `+`)
- **Email addresses**: `user@example.com` (for contacts using an Apple ID email)
- **Chat identifiers**: `chat123456789` (for group chats)

If not set, the bot responds to all incoming messages.

## Step 3: Start the Daemon

```bash
# Development mode (foreground)
pnpm daemon:dev
```

You should see:

```
[imessage-receiver] Opened chat.db, starting from ROWID 12345
[imessage-adapter] Started — watching for incoming messages
[gateway]   Channels: imessage
```

## Usage

### Individual Chats

Send a message from any device (iPhone, iPad, another Mac) to the iMessage account on the Mac running the daemon. The bot responds to all incoming messages in 1:1 chats.

### Group Chats

The bot responds to all messages in allowed group chats. Add the group's chat identifier to `IMESSAGE_ALLOWED_CHATS` to enable it (or leave the variable unset to allow all).

### Message Limits

Long responses are automatically split into chunks at 4,000 characters, breaking at natural points (newlines, then spaces).

## How It Works

The adapter has three components:

### Receiving Messages

Messages are detected by watching `~/Library/Messages/chat.db`, the SQLite database that Messages.app uses to store all conversations:

1. On startup, the adapter records the current highest message ROWID as a high-water mark
2. A [chokidar](https://github.com/paulmillr/chokidar) file watcher monitors the WAL (Write-Ahead Log) file for changes, triggering near-instant message detection
3. A fallback poll runs every 5 seconds in case file-system events are missed
4. New messages (ROWID > high-water mark) are queried, filtered to incoming-only, and dispatched to the agent

### Sending Messages

Replies are sent via AppleScript using `osascript`:

- **1:1 chats**: Targets the recipient's handle (phone number or email) via `participant` of the iMessage service
- **Group chats**: Targets the chat by its GUID (e.g., `iMessage;+;chat123456`)

### Session Keys

Each conversation gets a stable session key for the daemon's session management:

- 1:1 chats: `imessage:+15551234567` or `imessage:user@example.com`
- Group chats: `imessage:chat123456789`

These are derived from the `chat_identifier` column in Messages.app's database and persist across restarts.

## Environment Variables

| Variable                 | Required | Default     | Description                                        |
| ------------------------ | -------- | ----------- | -------------------------------------------------- |
| `IMESSAGE_ENABLED`       | Yes      | —           | Set to `"true"` to enable the adapter              |
| `IMESSAGE_ALLOWED_CHATS` | No       | (all chats) | Comma-separated phone numbers, emails, or chat IDs |

## Troubleshooting

### "iMessage adapter requires macOS" error

This adapter only works on macOS. It cannot run on Linux or Windows.

### chat.db permission denied

Your terminal does not have Full Disk Access:

1. Go to **System Settings** > **Privacy & Security** > **Full Disk Access**
2. Add your terminal app
3. Restart the terminal and the daemon

### Messages not being received

- Verify Messages.app is open and signed into iMessage
- Check that the sender is not blocked in Messages.app
- If `IMESSAGE_ALLOWED_CHATS` is set, confirm the sender's identifier is listed
- Check daemon logs for `[imessage-receiver] Poll error:` messages — this may indicate a database lock issue (usually transient)

### Messages not being sent

- Verify the Automation permission: **System Settings** > **Privacy & Security** > **Automation** — your terminal should be allowed to control Messages.app
- Check that Messages.app is running and signed in
- Look for `[imessage-adapter] Send failed:` in daemon logs
- For group chats, ensure the Mac's iMessage account is a member of the group

### Finding chat identifiers for groups

To discover a group chat's identifier:

1. Start the daemon with `IMESSAGE_ALLOWED_CHATS` unset (allows all chats)
2. Send a test message in the group from another device
3. Look for the `channelId` in daemon logs — that is the chat identifier
4. Add it to `IMESSAGE_ALLOWED_CHATS`

Alternatively, you can query the database directly:

```bash
sqlite3 ~/Library/Messages/chat.db "SELECT chat_identifier, display_name FROM chat WHERE style = 45;"
```

(Style 45 = group chats, style 43 = 1:1 chats.)

### Delayed message detection

Messages are typically detected within 200ms via the WAL file watcher. If detection is slow:

- Ensure your terminal has Full Disk Access (the watcher may silently fail without it)
- The fallback poll runs every 5 seconds, so messages should appear within that window at most

### "No cached metadata" warning when sending

This occurs if the daemon tries to reply to a conversation it hasn't seen an incoming message for (e.g., after a restart). Send a message to the bot first to populate the metadata cache, then it can reply.

## Cross-Platform Alternatives (Future)

The current adapter requires the daemon to run directly on macOS. This section documents researched alternatives for running the daemon on Linux or other platforms while still bridging to iMessage.

### Why No-Mac iMessage Doesn't Work

Every project that attempted iMessage without any Mac has been blocked by Apple or abandoned:

- **pypush** ([github.com/JJTech0130/pypush](https://github.com/JJTech0130/pypush)) — Python library that reverse-engineered Apple's APNs protocol. Currently mid-rewrite with the iMessage, IDS, and authentication modules empty. The old working branch is unmaintained. Licensed under SSPL (restrictive, owned by Beeper).
- **Beeper Mini** — Launched late 2023, enabling iMessage on Android via reverse-engineered protocol. Apple blocked it within days and repeatedly after workarounds. The [beeper/imessage](https://github.com/beeper/imessage) repo was archived April 2024. Beeper was acquired by Automattic and pivoted away.

Apple actively detects and blocks unauthorized iMessage clients, and users risk Apple ID suspension. This approach is not viable for sustained use.

### Mac-as-Relay Architecture

A Mac can serve as a remote iMessage relay while the daemon runs on any platform. Two actively maintained options:

#### BlueBubbles

[github.com/BlueBubblesApp/bluebubbles-server](https://github.com/BlueBubblesApp/bluebubbles-server) — TypeScript Electron app that runs on a Mac and exposes iMessage via REST API + Socket.IO.

- **License**: Apache-2.0
- **Status**: Actively maintained (last pushed Jan 2026)
- **Features**: Send, receive, group chats, attachments, reactions, typing indicators, read receipts, scheduled messages
- **API docs**: [Postman collection](https://documenter.getpostman.com/view/765844/UV5RnfwM)
- **Validated by**: mautrix-imessage's BlueBubbles connector

A daemon adapter could connect to a BlueBubbles instance over HTTP/Socket.IO, making the daemon itself platform-independent. Any Mac (even a Mac Mini or cloud Mac via MacStadium) can serve as the relay.

#### @photon-ai/advanced-imessage-kit

[npmjs.com/package/@photon-ai/advanced-imessage-kit](https://www.npmjs.com/package/@photon-ai/advanced-imessage-kit) — Native TypeScript SDK with a companion macOS server (`@photon-ai/advanced-imessage-http-proxy`).

- **License**: MIT
- **Status**: Actively maintained
- **Features**: Send, receive, replies, tapbacks, edit, unsend, typing indicators, attachments, stickers, polls, Find My, contacts, group management, FaceTime
- **Integration**: Native TypeScript SDK connecting via Socket.IO + HTTP — designed for AI agent use cases

#### Comparison

| Approach                    | Mac Required      | Daemon Platform | TS Integration           | Risk                         |
| --------------------------- | ----------------- | --------------- | ------------------------ | ---------------------------- |
| Current adapter (local)     | Yes (daemon host) | macOS only      | Native                   | Low                          |
| BlueBubbles relay           | Yes (server only) | Any             | REST + Socket.IO         | Low                          |
| photon-ai relay             | Yes (server only) | Any             | Native TS SDK            | Low                          |
| Reverse-engineered (pypush) | No                | Any             | Poor (Python subprocess) | High — Apple blocks actively |

Neither relay approach has been implemented yet. The current adapter covers the macOS-local use case.
