# Messages.app (iMessage) Integration

Connect Nomos to iMessage / SMS via the [`imsg`](https://github.com/openclaw/imsg)
CLI -- a local-first iMessage tool that reads `chat.db` directly, watches for
new messages via filesystem events, and sends through Messages.app.

> **macOS required.** The `imsg` CLI is macOS-only. The Nomos daemon must run
> on the same Mac where Messages.app is signed in.

## Overview

The integration has two configuration axes:

**Feature mode** -- how much you can do:

| Mode                | Setup                 | Read | Send text | Send files | Standard tapbacks | Edit | Unsend | Typing | Custom reactions | Effects |
| ------------------- | --------------------- | ---- | --------- | ---------- | ----------------- | ---- | ------ | ------ | ---------------- | ------- |
| **Basic** (default) | Just install `imsg`   | ✅   | ✅        | ✅         | ✅                | ❌   | ❌     | ❌     | ❌               | ❌      |
| **Advanced**        | Requires SIP disabled | ✅   | ✅        | ✅         | ✅                | ✅   | ✅     | ✅     | ✅               | ✅      |

**Agent mode** -- how the agent handles messages:

| Mode                  | Behavior                                                                                                                   |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **Passive** (default) | Watches all conversations, drafts responses for your approval before sending. Drafts appear in your default Slack channel. |
| **Agent**             | Only processes messages from the owner (your phone or Apple ID), responds directly. Acts as a personal agent client.       |

## Quick Start

### 1. Install the `imsg` CLI

`imsg` is auto-installed as a Homebrew dependency of nomos, so `brew install nomos`
already installed it. Verify:

```bash
imsg --version
```

(Standalone install if needed: `brew install steipete/tap/imsg`.)

### 2. Grant macOS permissions

The terminal (or the parent app launching `imsg`) needs:

- **Full Disk Access** -- to read `~/Library/Messages/chat.db`
  - System Settings → Privacy & Security → Full Disk Access → add your terminal
- **Automation** for Messages.app -- to send messages
  - Granted automatically on first `imsg send` (you'll see a permission prompt)
- **Contacts** (optional) -- for name resolution in JSON output

### 3. Enable in Nomos

**Via Settings UI** (recommended): Navigate to `http://localhost:3456/integrations/imessage`,
toggle "Enable Messages.app integration", choose feature mode (basic/advanced) and agent mode.

**Via env vars:**

```bash
IMESSAGE_ENABLED=true
IMESSAGE_FEATURE_MODE=basic           # basic | advanced
IMESSAGE_AGENT_MODE=passive           # passive | agent
IMESSAGE_OWNER_PHONE=+15551234567     # required for agent mode
IMESSAGE_OWNER_APPLE_ID=you@icloud.com
```

### 4. Restart the daemon

```bash
nomos daemon restart
```

You should see:

```
[imessage-adapter] Starting (agent: passive, features: basic, imsg: 0.x.x)
[imsg-adapter] Started in basic mode (watching chat.db)
```

## Feature Modes

### Basic Mode (recommended)

The default mode covers everything most users need:

- **Read** message history (`imsg history`)
- **Watch** new messages in real time via filesystem events (`imsg watch`)
- **Send** text and files through Messages.app via AppleScript
- **React** with standard tapbacks: 👍 ❤️ 😂 ‼️ ❓ 👎 (`like`, `love`, `laugh`, `emphasis`, `question`, `dislike`)
- **Search** chat history (`imsg search`)
- **Group-aware** -- detects group chats, participants, and chat GUIDs

No system modifications required. Just standard macOS permissions.

### Advanced Mode (SIP disabled required)

Adds features that require macOS's IMCore bridge:

- **Edit** previously sent messages
- **Unsend** messages
- **Typing indicators**
- **Custom emoji reactions** (any emoji, not just the six standard tapbacks)
- **Message effects** (slam, gentle, confetti, etc.)
- **Group management** -- create groups, rename, add/remove members, set photo
- **Read receipts** (send + suppress)

#### Enabling Advanced Mode

⚠️ **Security trade-off:** Advanced mode requires disabling System Integrity Protection (SIP), a core macOS security boundary. Only proceed if you understand the implications.

1. **Boot into Recovery Mode**
   - Apple Silicon: shut down, hold the power button until "Loading startup options" appears, select Options
   - Intel: restart, hold ⌘R until the Apple logo appears

2. **Disable SIP**
   Open Terminal (Utilities menu → Terminal) and run:

   ```bash
   csrutil disable
   ```

3. **Reboot normally**

4. **Load the IMCore bridge**

   ```bash
   imsg launch
   ```

   This loads a dylib into Messages.app that exposes the advanced APIs. It runs once and persists until reboot.

5. **In Nomos Settings UI** → Messages.app → switch feature mode to **Advanced**.

6. **Re-enable SIP** (optional but recommended for everyday use)
   Boot back into Recovery Mode and run `csrutil enable`. Advanced features will stop working until you disable SIP again -- consider using a dedicated agent machine if you want both security and advanced features.

## Agent Modes

### Passive Mode (default)

Best for: shared phones, family Macs, or when you want approval before any reply.

- All incoming messages are watched
- The agent drafts responses based on your style (learned from history and exemplars)
- Drafts appear in your **default notification channel** (typically a Slack channel) with Approve / Edit / Decline buttons
- Nothing is sent until you approve

Configure your default channel in Settings UI under **Integrations → Default Notification**.

### Agent Mode

Best for: dedicated personal-agent Mac, or when you want the agent to act as your client.

- The adapter only processes messages **from you** (matched against `IMESSAGE_OWNER_PHONE` and/or `IMESSAGE_OWNER_APPLE_ID`)
- The agent responds directly to your commands
- Messages from others are ignored (so the agent doesn't accidentally reply to someone)

Required env vars in agent mode:

```bash
IMESSAGE_AGENT_MODE=agent
IMESSAGE_OWNER_PHONE=+15551234567     # at least one of these
IMESSAGE_OWNER_APPLE_ID=you@icloud.com
```

## How It Works

### Incoming messages

The adapter spawns `imsg watch --json --reactions --attachments` as a long-running
subprocess. This streams newline-delimited JSON for each new message, using
filesystem events on `chat.db` (with a poll fallback). Detection latency is
typically sub-second.

Each message includes:

- `chat_identifier` / `chat_guid` / `chat_name` -- routing info
- `sender` / `sender_name` -- raw handle + resolved name (if Contacts permission granted)
- `text` -- message body
- `is_group` / `participants` -- group context
- `attachments[]` -- filename, MIME type, byte count, resolved path
- `guid` -- message GUID (needed for reactions, edit, unsend)
- `created_at` -- ISO timestamp

### Outgoing messages

The adapter shells out to `imsg send`:

```bash
imsg send --to "+14155551212" --text "on my way"
imsg send --to "Jane Appleseed" --file ~/Desktop/voice.m4a
```

`imsg` resolves contact names via Address Book, picks the right service
(iMessage vs SMS) based on the recipient, and sends through Messages.app.
Long messages are automatically chunked (Slack-style 4000-char chunks).

### Historical ingestion

For bulk historical ingestion (training the agent's style on past conversations),
the ingest pipeline reads `chat.db` directly via SQLite. See [Ingestion](../ingestion.md).

## MCP Tools

The agent has these in-process tools available:

- `imessage_send` -- send a text message to a recipient
- `imessage_read` -- read recent messages from a contact (uses `imsg history`)

For tapbacks and other actions, the agent uses `Bash` with the `imsg` CLI directly:

```bash
# Examples the agent can run:
imsg react --chat-id 42 --reaction like
imsg history --chat-id 42 --limit 50 --json
imsg search --query "pizza" --json
```

## Environment Variables

| Variable                  | Required        | Default   | Description                       |
| ------------------------- | --------------- | --------- | --------------------------------- |
| `IMESSAGE_ENABLED`        | Yes             | `false`   | Set to `true` to enable           |
| `IMESSAGE_FEATURE_MODE`   | No              | `basic`   | `basic` or `advanced`             |
| `IMESSAGE_AGENT_MODE`     | No              | `passive` | `passive` or `agent`              |
| `IMESSAGE_OWNER_PHONE`    | Agent mode only | --        | Owner phone number (E.164 format) |
| `IMESSAGE_OWNER_APPLE_ID` | Agent mode only | --        | Owner Apple ID email              |

## Troubleshooting

### "imsg CLI is not installed"

```bash
brew install steipete/tap/imsg
imsg --version
```

### `chat.db` permission denied

Grant Full Disk Access to your terminal / IDE:

- System Settings → Privacy & Security → Full Disk Access → add Terminal (or iTerm, VS Code, etc.)
- Restart the terminal after granting

### Messages not being received

- Check the daemon logs for `[imsg-adapter]` lines
- Verify `imsg watch` runs interactively: `imsg watch --json`
- Confirm Full Disk Access is granted to the process running the daemon

### Messages not being sent

- Check Automation permission: System Settings → Privacy & Security → Automation → Terminal → Messages.app should be enabled
- Make sure Messages.app is running and signed in to iMessage
- Try sending manually: `imsg send --to "+15551234567" --text "test"`

### Advanced features not working

- Confirm SIP is disabled: `csrutil status` should report "System Integrity Protection status: disabled"
- Run `imsg launch` after every reboot (or add it to a startup item)
- Run `imsg status --json` to verify the bridge is loaded

### Looking up a group chat ID

```bash
imsg chats --json | jq 'select(.is_group)'
```

## Why `imsg`?

Earlier versions of this integration supported three modes (chat.db direct,
BlueBubbles REST server, Photon Socket.IO server). Those were consolidated to
`imsg` because:

- **One trusted maintainer** -- steipete (well-known Apple developer) actively
  maintains it
- **Local-first** -- no separate server process to install/configure/keep running
- **Stable JSON schema** -- explicitly designed for agents and scripts
- **Same chat.db source of truth** as the old `chatdb` mode, but with
  filesystem-event streaming instead of polling
- **Advanced features available** if you opt in to SIP-disabled mode (was
  BlueBubbles/Photon's main draw)
- **Smaller codebase** -- replaces ~1,300 LOC of adapter code with ~250

See the [imsg README](https://github.com/openclaw/imsg) for full docs.
