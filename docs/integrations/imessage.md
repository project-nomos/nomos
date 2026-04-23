# iMessage Integration

Connect Nomos to iMessage with two connection modes: **local chat.db** (zero setup, macOS-only) or **BlueBubbles** (full bidirectional, cross-platform via a Mac relay).

> **macOS required** for both modes -- either as the daemon host (chat.db mode) or as a BlueBubbles relay server.

## Agent Modes

Messages.app supports two agent modes that control how Nomos interacts with incoming messages:

|                  | Passive                                              | Agent Client                            |
| ---------------- | ---------------------------------------------------- | --------------------------------------- |
| **Listens to**   | All incoming messages (or filtered by allowed chats) | Only your phone number and Apple ID     |
| **Responds via** | Drafts in Slack for approval before sending          | Directly via iMessage                   |
| **Use case**     | Monitor conversations, review before replying        | Chat with your agent from your iPhone   |
| **Risk level**   | Safe -- nothing sent without approval                | Active -- sends responses automatically |

### Passive Mode (default)

Nomos listens to incoming iMessages, processes them through the agent, and drafts responses in your default Slack channel. You review and approve/reject each response before it's sent. This is the safest option for monitoring conversations.

### Agent Client Mode

Nomos acts as a personal agent client -- only responding to messages from your phone number and/or Apple ID. All other messages are ignored. Use this to interact with your agent directly from your iPhone, like having a personal assistant in your Messages app.

**Required**: At least one owner identity (phone number or Apple ID) must be set. Configure via Settings UI or environment variables:

```bash
IMESSAGE_AGENT_MODE=agent
IMESSAGE_OWNER_PHONE=+15551234567
IMESSAGE_OWNER_APPLE_ID=you@icloud.com
```

## Choose Your Connection Mode

|                        | Local chat.db                | BlueBubbles          | Photon Server                      |
| ---------------------- | ---------------------------- | -------------------- | ---------------------------------- |
| **Read messages**      | SQLite polling + WAL watcher | Webhooks (real-time) | Socket.IO (real-time)              |
| **Send messages**      | AppleScript                  | REST API             | REST API                           |
| **Reactions/tapbacks** | No                           | Yes                  | Yes                                |
| **Typing indicators**  | No                           | Yes                  | Yes                                |
| **Read receipts**      | No                           | Yes                  | Yes                                |
| **Attachments**        | No                           | Yes (up to 8MB)      | Yes                                |
| **Message effects**    | No                           | No                   | Yes (slam, loud, etc.)             |
| **Scheduled messages** | No                           | No                   | Yes                                |
| **Rich link previews** | No                           | No                   | Yes                                |
| **Contact cards**      | No                           | No                   | Yes                                |
| **Group management**   | No                           | Yes                  | Yes                                |
| **Daemon platform**    | macOS only                   | Any (Mac is relay)   | Any (Mac is relay)                 |
| **Setup complexity**   | Minimal                      | Moderate             | Moderate                           |
| **Package**            | Built-in                     | Built-in             | `@photon-ai/advanced-imessage-kit` |

**Recommendation:** Start with chat.db for the simplest setup. Switch to Photon for full-featured iMessage automation (reactions, effects, scheduled messages). Use BlueBubbles as an alternative cross-platform relay.

Configure the mode via Settings UI at `/integrations/imessage` or with the `IMESSAGE_MODE` env var.

---

## Mode 1: Local chat.db (Default)

### Prerequisites

- macOS with Messages.app signed into iMessage
- Messages.app running (must stay open)
- **Full Disk Access** granted to your terminal app
- **Automation** permission for `osascript` to control Messages.app
- Nomos daemon running

### Step 1: Grant Permissions

#### Full Disk Access

1. Open **System Settings** > **Privacy & Security** > **Full Disk Access**
2. Click **+** and add your terminal application
3. Restart the terminal after granting access

#### Automation Permission

The first time a message is sent, macOS will prompt to allow your terminal to control Messages.app. Click **OK**.

### Step 2: Enable iMessage

**Via Settings UI:** Go to `/integrations/imessage`, enable iMessage, select "Local chat.db" mode.

**Via environment:**

```bash
IMESSAGE_ENABLED=true
IMESSAGE_MODE=chatdb          # default, can be omitted
```

### Step 3: Start the Daemon

```bash
nomos daemon run
```

You should see:

```
[imessage-receiver] Opened chat.db, starting from ROWID 12345
[imessage-adapter] Started in chat.db mode — watching for incoming messages
```

### How chat.db Mode Works

1. On startup, records the current highest message ROWID as a high-water mark
2. A chokidar file watcher monitors the WAL file for near-instant detection (~200ms)
3. A fallback poll runs every 5 seconds in case file-system events are missed
4. New messages (ROWID > high-water mark) are queried, filtered to incoming-only, and dispatched
5. Replies are sent via AppleScript (`osascript`)

---

## Mode 2: BlueBubbles

BlueBubbles is a macOS server that exposes iMessage via REST API + webhooks. The daemon connects to it over HTTP, enabling full bidirectional iMessage support from any platform.

### Prerequisites

- A Mac running BlueBubbles server (can be a Mac Mini, cloud Mac, etc.)
- BlueBubbles installed and configured with web API enabled
- Network connectivity between the daemon and the BlueBubbles Mac
- Nomos daemon running (on any platform)

### Step 1: Install BlueBubbles

1. Download and install from [bluebubbles.app](https://bluebubbles.app)
2. Follow the setup wizard — sign into iCloud, enable web API
3. In BlueBubbles settings:
   - Enable the **REST API**
   - Note the **server URL** (e.g., `http://192.168.1.100:1234`)
   - Note the **password** (found in Settings > API/Web Settings)

### Step 2: Install the Keep-Alive Script

BlueBubbles needs Messages.app running. Install the keep-alive LaunchAgent to ensure it stays open:

```bash
cd scripts/bluebubbles
./install-keepalive.sh
```

This installs:

- `~/Scripts/poke-messages.scpt` — AppleScript that pokes Messages.app
- `~/Library/LaunchAgents/com.nomos.poke-messages.plist` — Runs every 5 minutes

To uninstall:

```bash
launchctl unload ~/Library/LaunchAgents/com.nomos.poke-messages.plist
rm ~/Library/LaunchAgents/com.nomos.poke-messages.plist
rm ~/Scripts/poke-messages.scpt
```

### Step 3: Configure Nomos

**Via Settings UI:** Go to `/integrations/imessage`, enable iMessage, select "BlueBubbles Server" mode, enter your server URL and password. Use the "Test Connection" button to verify.

**Via environment:**

```bash
IMESSAGE_ENABLED=true
IMESSAGE_MODE=bluebubbles
BLUEBUBBLES_SERVER_URL=http://192.168.1.100:1234
BLUEBUBBLES_PASSWORD=your-bluebubbles-password
```

### Step 4: Configure Webhooks in BlueBubbles

Point BlueBubbles webhooks to your Nomos daemon:

1. In BlueBubbles, go to **Settings > Webhooks**
2. Add a new webhook URL:
   ```
   http://your-nomos-host:8803/bluebubbles-webhook?password=your-bluebubbles-password
   ```
3. Enable the **New Message** event
4. Save

### Step 5: Start the Daemon

```bash
nomos daemon run
```

You should see:

```
[bluebubbles] Webhook listening on port 8803
[imessage-adapter] Started in BlueBubbles mode — server: http://192.168.1.100:1234
```

### BlueBubbles Environment Variables

| Variable                       | Required | Default            | Description                        |
| ------------------------------ | -------- | ------------------ | ---------------------------------- |
| `BLUEBUBBLES_SERVER_URL`       | Yes      | --                 | BlueBubbles server URL             |
| `BLUEBUBBLES_PASSWORD`         | Yes      | --                 | Server API password                |
| `BLUEBUBBLES_WEBHOOK_PORT`     | No       | `8803`             | Port for receiving webhooks        |
| `BLUEBUBBLES_WEBHOOK_PASSWORD` | No       | (same as password) | Separate webhook auth password     |
| `BLUEBUBBLES_READ_RECEIPTS`    | No       | `false`            | Send read receipts when processing |

### BlueBubbles Capabilities

Beyond basic messaging, BlueBubbles enables:

- **Reactions/tapbacks** — React to messages programmatically
- **Typing indicators** — Show typing status to contacts
- **Read receipts** — Mark messages as read
- **Attachments** — Send and receive files (up to 8MB)
- **Group management** — Create groups, add/remove participants, rename
- **Message effects** — iMessage effects like "slam" and "loud"
- **Edit/unsend** — Edit or unsend sent messages

---

## Mode 3: Photon Server

Photon is a full-featured iMessage server that provides the richest set of capabilities: reactions, message effects, scheduled messages, rich link previews, contact cards, and more.

### Prerequisites

- A Mac running the Photon iMessage server
- Photon server configured with HTTP API enabled
- Network connectivity between the daemon and the Photon Mac
- Nomos daemon running (on any platform)

### Step 1: Install Photon Server

Follow the [Photon setup guide](https://github.com/photon-hq/advanced-imessage-kit) to install and configure the server on your Mac.

### Step 2: Configure Nomos

**Via Settings UI:** Go to `/integrations/imessage`, enable iMessage, select "Photon Server" mode, enter your server URL and API key.

**Via environment:**

```bash
IMESSAGE_ENABLED=true
IMESSAGE_MODE=photon
PHOTON_SERVER_URL=http://your-mac-ip:1234
PHOTON_API_KEY=your-api-key          # optional, if server requires auth
```

### Step 3: Start the Daemon

```bash
nomos daemon run
```

You should see:

```
[imessage-photon] Connected to Photon server at http://your-mac-ip:1234
[imessage-adapter] Started in Photon mode (passive) -- server: http://your-mac-ip:1234
```

### Photon Capabilities

Beyond basic messaging, Photon enables:

- **Reactions/tapbacks** -- love, like, dislike, laugh, emphasize, question
- **Message effects** -- slam, loud, gentle, invisible ink, etc.
- **Scheduled messages** -- send messages at a specified time
- **Rich link previews** -- send URLs with proper previews
- **Contact cards** -- share contact information
- **Typing indicators** -- show typing status
- **Read receipts** -- mark messages as read
- **Message editing** -- edit or unsend sent messages
- **Attachments** -- send and receive files
- **Polls** -- create and vote in iMessage polls

### Photon Environment Variables

| Variable            | Required | Default | Description                |
| ------------------- | -------- | ------- | -------------------------- |
| `PHOTON_SERVER_URL` | Yes      | --      | Photon server URL          |
| `PHOTON_API_KEY`    | No       | --      | API key for authentication |

---

## Common Settings (All Modes)

### Restrict to Specific Contacts or Groups

```bash
IMESSAGE_ALLOWED_CHATS=+15551234567,user@example.com,chat123456789
```

Comma-separated list. Accepts:

- **Phone numbers**: `+15551234567` (international format with `+`)
- **Email addresses**: `user@example.com`
- **Chat identifiers**: `chat123456789` (for group chats)

If not set, the bot responds to all incoming messages.

### Session Keys

Each conversation gets a stable session key:

- 1:1 chats: `imessage:+15551234567` or `imessage:user@example.com`
- Group chats: `imessage:chat123456789`

### Message Limits

Long responses are automatically split into chunks at 4,000 characters, breaking at natural points (newlines, then spaces).

---

## All Environment Variables

| Variable                       | Required         | Default            | Description                                       |
| ------------------------------ | ---------------- | ------------------ | ------------------------------------------------- |
| `IMESSAGE_ENABLED`             | Yes              | --                 | Set to `"true"` to enable                         |
| `IMESSAGE_MODE`                | No               | `chatdb`           | Connection: `chatdb`, `bluebubbles`, or `photon`  |
| `IMESSAGE_AGENT_MODE`          | No               | `passive`          | Agent mode: `passive` (draft) or `agent` (direct) |
| `IMESSAGE_OWNER_PHONE`         | Agent mode       | --                 | Owner phone number (e.g., `+15551234567`)         |
| `IMESSAGE_OWNER_APPLE_ID`      | Agent mode       | --                 | Owner Apple ID email (e.g., `you@icloud.com`)     |
| `IMESSAGE_ALLOWED_CHATS`       | No               | (all chats)        | Comma-separated identifiers (passive mode filter) |
| `BLUEBUBBLES_SERVER_URL`       | BlueBubbles only | --                 | Server URL                                        |
| `BLUEBUBBLES_PASSWORD`         | BlueBubbles only | --                 | API password                                      |
| `BLUEBUBBLES_WEBHOOK_PORT`     | No               | `8803`             | Webhook listener port                             |
| `BLUEBUBBLES_WEBHOOK_PASSWORD` | No               | (same as password) | Webhook auth password                             |
| `BLUEBUBBLES_READ_RECEIPTS`    | No               | `false`            | Send read receipts                                |
| `PHOTON_SERVER_URL`            | Photon only      | --                 | Photon server URL                                 |
| `PHOTON_API_KEY`               | No               | --                 | Photon API key (if server requires auth)          |

---

## Troubleshooting

### "iMessage chat.db mode requires macOS"

Switch to BlueBubbles mode (`IMESSAGE_MODE=bluebubbles`) to run the daemon on non-Mac platforms.

### chat.db permission denied

Your terminal does not have Full Disk Access:

1. Go to **System Settings** > **Privacy & Security** > **Full Disk Access**
2. Add your terminal app
3. Restart the terminal and the daemon

### Messages not being received (chat.db)

- Verify Messages.app is open and signed into iMessage
- Check that the sender is not blocked
- If `IMESSAGE_ALLOWED_CHATS` is set, confirm the sender's identifier is listed
- Check daemon logs for `[imessage-receiver] Poll error:` messages

### Messages not being received (BlueBubbles)

- Verify the BlueBubbles server is running and reachable
- Check that webhooks are configured correctly in BlueBubbles settings
- Verify the webhook URL includes the correct password
- Check daemon logs for `[bluebubbles] Webhook parse error:` messages

### Messages not being sent (chat.db)

- Verify Automation permission: **System Settings** > **Privacy & Security** > **Automation**
- Check that Messages.app is running and signed in
- Look for `[imessage-adapter] Send failed:` in daemon logs

### Messages not being sent (BlueBubbles)

- Test the connection via Settings UI or: `curl "http://your-server:1234/api/v1/ping?password=your-password"`
- Check that the BlueBubbles server has iMessage active
- Look for `[imessage-adapter] BlueBubbles send failed:` in daemon logs

### "No cached metadata" warning

Occurs if the daemon tries to reply to a conversation it hasn't seen an incoming message for. Send a message to the bot first to populate the cache.

### BlueBubbles server goes offline

The keep-alive script (`install-keepalive.sh`) ensures Messages.app stays running. If the BlueBubbles server itself crashes, restart it manually or configure it as a login item.

### Finding chat identifiers for groups

Start the daemon with `IMESSAGE_ALLOWED_CHATS` unset, send a test message in the group, then check daemon logs for the `channelId`.

Or query directly (chat.db mode):

```bash
sqlite3 ~/Library/Messages/chat.db "SELECT chat_identifier, display_name FROM chat WHERE style = 45;"
```
