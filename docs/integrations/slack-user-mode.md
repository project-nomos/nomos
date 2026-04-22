# Slack User Mode

Slack User Mode lets Nomos act **as you** in Slack. Instead of replying as a bot, it listens to DMs and @mentions directed at your personal Slack account and responds using your user token — so messages appear as if you typed them yourself.

There are two ways to run user mode:

| Mode             | Command              | Approval                                | Best for                     |
| ---------------- | -------------------- | --------------------------------------- | ---------------------------- |
| **CLI listener** | `nomos slack listen` | Sends directly (you're at the terminal) | Interactive use, quick setup |
| **Daemon**       | `nomos daemon start` | Draft → approve → send                  | Background / unattended      |

Both use Socket Mode and your `xoxp-` user token.

## How It Works

### CLI Listener (direct mode)

```
1. Someone DMs you or @mentions you in a channel
     ↓
2. nomos slack listen picks up the message via Socket Mode
     ↓
3. The agent generates a response
     ↓
4. The response is posted immediately via your xoxp- token
   → It appears in Slack as if you typed it
```

### Daemon (draft-approval mode)

```
1. Someone DMs you or @mentions you in a channel
     ↓
2. SlackUserAdapter picks up the message via Socket Mode
     ↓
3. The agent generates a response
     ↓
4. Instead of sending, a draft is created in the database
     ↓
5. You're notified in two places:
   • CLI: a system event appears; use /drafts to view
   • Slack: the bot sends you a DM with Approve / Reject buttons
     ↓
6. You approve (or reject):
   • CLI: /approve <id>
   • Slack: click the Approve button
     ↓
7. On approval, the message is posted via your xoxp- token
   → It appears in Slack as if you typed it
```

## Prerequisites

- A working bot-mode Slack integration (see [slack.md](slack.md))
- A Slack User OAuth Token (`xoxp-`) with the required scopes
- The same App-Level Token (`xapp-`) already used for bot mode

## Step 1: Add User Token Scopes

Your Slack app needs **User Token Scopes** in addition to the existing Bot Token Scopes.

1. Go to [https://api.slack.com/apps](https://api.slack.com/apps) and select your app
2. Go to **OAuth & Permissions** in the sidebar
3. Scroll to **User Token Scopes** (below Bot Token Scopes)
4. Add the following scopes:

| Scope              | Purpose                                 |
| ------------------ | --------------------------------------- |
| `channels:history` | Read messages in public channels        |
| `channels:read`    | List public channels (for name lookups) |
| `groups:history`   | Read messages in private channels       |
| `groups:read`      | List private channels                   |
| `im:history`       | Read your direct messages               |
| `im:read`          | View DM metadata                        |
| `mpim:history`     | Read multi-party DMs                    |
| `chat:write`       | Send messages as you                    |
| `users:read`       | Look up sender names                    |

## Step 2: Subscribe to Team Events

Team events fire for messages directed at the **user** (not the bot).

1. Go to **Event Subscriptions** in the sidebar
2. Under **Subscribe to events on behalf of users** (not "bot events"), add:

| Event              | Description                  |
| ------------------ | ---------------------------- |
| `message.channels` | Messages in public channels  |
| `message.groups`   | Messages in private channels |
| `message.im`       | Direct messages to the user  |
| `message.mpim`     | Multi-party DMs              |

3. Click **Save Changes**

## Step 3: Enable Interactivity

Interactivity is needed for the Approve/Reject buttons sent via bot DM. If you're using Socket Mode (which you are), Bolt handles interactivity through the socket connection — no Request URL is needed.

1. Go to **Interactivity & Shortcuts** in the sidebar
2. Toggle **Interactivity** to On
3. Click **Save Changes**

> With Socket Mode enabled, you don't need to enter a Request URL. Bolt receives interaction payloads through the socket.

## Step 4: Reinstall the App

After adding new scopes and events, you must reinstall:

1. Go to **Install App** in the sidebar
2. Click **Reinstall to Workspace**
3. Review and approve the updated permissions
4. Copy the **User OAuth Token** (starts with `xoxp-`) — this is your `SLACK_USER_TOKEN`

> The User OAuth Token appears at the top of the OAuth & Permissions page, above the Bot User OAuth Token.

## Step 5: Configure Environment

You need `SLACK_APP_TOKEN` (`xapp-`) for Socket Mode, then connect one or more workspaces:

```bash
SLACK_APP_TOKEN=xapp-...           # Same as bot mode
```

### Connecting Workspaces

There are three ways to connect a workspace:

#### Option A: Via `nomos-slack-mcp` OAuth (recommended for multi-workspace)

```bash
npx nomos-slack-mcp add-workspace
```

This opens a browser for OAuth authorization. Tokens are stored in `~/.nomos/slack/config.json` and synced to the database on daemon start.

> Multi-workspace OAuth requires your Slack app to have distribution enabled. See [Enabling Distribution](slack.md#enabling-distribution).

#### Option B: Manual token

```bash
nomos slack auth --token xoxp-...
```

Or via the Settings UI: **Integrations → Slack → Manual Token**. Works for any workspace without distribution.

#### Option C: Settings UI OAuth

Authorize workspaces directly from the Settings UI:

1. Set `SLACK_CLIENT_ID` and `SLACK_CLIENT_SECRET` in **App Configuration**
2. Click **Authorize Workspace**

> Multi-workspace requires [distribution enabled](slack.md#enabling-distribution).

#### Option D: Browser Auth (experimental)

Set `NOMOS_BROWSER_AUTH=true` to enable. Opens a browser window to capture tokens automatically — no Slack app required. See [Browser Auth](slack.md#option-d-browser-auth-experimental) for details.

### Managing Workspaces

```bash
nomos slack workspaces       # List all connected workspaces
nomos slack remove T01ABC    # Disconnect a workspace
```

### Legacy: Single workspace via env var

```bash
SLACK_APP_TOKEN=xapp-...
SLACK_USER_TOKEN=xoxp-...
```

> If both DB workspaces and `SLACK_USER_TOKEN` are present, DB workspaces take priority. The env var is only used as a fallback when no workspaces are stored in the database.

## Step 6: Run Migrations

User mode stores workspace tokens (and optionally drafts) in database tables. Run migrations to create them:

```bash
pnpm dev -- db migrate
```

## Step 7: Start Listening

### Option A: CLI Listener (recommended for interactive use)

```bash
nomos slack listen
```

This starts listening in the foreground as your personal Slack account. Responses are sent directly — no draft approval needed since you're at the terminal.

```
Starting Slack listener (user mode)...

  Workspace: My Company (T01ABC) — listening as alice (U0YYYYYY)

Listening for Slack messages as you. Press Ctrl+C to stop.
Responds to DMs and @mentions. Messages are sent as your account.
```

### Option B: Daemon (for background / unattended use)

```bash
pnpm daemon:dev
```

You should see adapters start for each connected workspace:

```
[slack-adapter] Running (bot: U0XXXXXX)
[slack-user-adapter] Running (user: U0YYYYYY, team: T01ABC)
[slack-user-adapter] Running (user: U0YYYYYY, team: T02DEF)
[gateway]   Channels: slack, slack-user:T01ABC, slack-user:T02DEF
```

In daemon mode, responses go through draft approval before being sent.

## Usage

### Receiving Messages

Both modes trigger on three types of incoming messages:

- **Default channel** -- your designated chat channel with the agent. All messages are processed, no @mention needed. The agent responds directly using the bot identity.
- **Direct messages** to your Slack account -- any DM from another user
- **@mentions** of your Slack account in channels -- when someone writes `@YourName` in a message

Your own messages are ignored (no echo loop), except in the default channel where you're chatting directly with the agent.

### Default Channel (Chat with Your Agent)

The default channel is a dedicated Slack channel where you talk directly to the agent -- like a personal chat room. It behaves differently from DMs and @mentions:

|                       | Default Channel                  | DMs / @Mentions                                    |
| --------------------- | -------------------------------- | -------------------------------------------------- |
| **Who triggers**      | You (the owner)                  | Other people messaging you                         |
| **@mention needed**   | No                               | @mentions required in channels, DMs always trigger |
| **Agent responds as** | Bot identity (own name + avatar) | Your user token (appears as you)                   |
| **Approval needed**   | No -- responds directly          | Yes -- creates draft for approval                  |
| **Polled**            | Every cycle (~60s)               | Active DMs every cycle, full scan every ~10 min    |

**Setup:**

1. Create a Slack channel (e.g., `#my-agent` or `#nomos-mgmt`)
2. Add the Slack bot app to the channel
3. Set it as the notification default via Settings UI (**Integrations > Slack > Notification Defaults**) or CLI:
   ```bash
   nomos config set notifications.default '{"platform":"slack-user:YOUR_TEAM_ID","channelId":"CHANNEL_ID","label":"#my-agent"}'
   ```
4. Ensure `SLACK_BOT_TOKEN` is configured (via Settings UI or `.env`) -- this gives the agent its own identity in the channel

**How it works:**

- The polling adapter checks the default channel on every poll cycle (~60s)
- Your messages are passed as raw text to the agent (no "draft a response AS ME" framing)
- The agent responds using the bot token, so responses appear with the bot's name and avatar
- Bot messages are filtered out to prevent echo loops (via `bot_id` field)
- All other channels continue using the user token for drafts sent on your behalf

### Reviewing Drafts (daemon mode only)

> **Note:** The CLI listener (`nomos slack listen`) sends responses directly — drafts are only used in daemon mode.

When the agent finishes generating a response in daemon mode, you'll see it in two places:

**In the CLI:**

```
/drafts
```

Shows all pending drafts with short IDs, context, age, and a content preview:

```
Pending drafts (2):
  a1b2c3d4 [DM from Alice] 3m ago
    Thanks for the update! I'll review the PR this afternoon and...
  e5f6g7h8 [#engineering] 12m ago
    Good point — we should add integration tests before merging...

Use /approve <id> or /reject <id>
```

**In Slack:**

The bot sends you a DM with the draft content and two buttons:

```
┌──────────────────────────────────────┐
│ Draft response ready                  │
│ DM from Alice                         │
│                                       │
│ ┌──────────────────────────────────┐ │
│ │ Thanks for the update! I'll     │ │
│ │ review the PR this afternoon... │ │
│ └──────────────────────────────────┘ │
│                                       │
│  [Approve]  [Reject]                  │
└──────────────────────────────────────┘
```

### Approving or Rejecting

**From the CLI:**

```bash
/approve a1b2c3d4    # Approve by short ID (first 8 chars)
/reject e5f6g7h8     # Reject by short ID
```

**From Slack:**

Click the **Approve** or **Reject** button in the bot's DM. The message updates in-place to confirm the action.

### What Happens on Approval

The approved message is posted to the original channel or DM thread using your `xoxp-` user token. In Slack, it appears as a normal message from you — other users cannot tell it was agent-assisted.

### What Happens on Rejection

The draft is marked as rejected. No message is sent. The draft remains in the database for audit purposes but won't appear in `/drafts`.

### Draft Expiry

Drafts expire after 24 hours. Expired drafts are automatically cleaned up and won't appear in `/drafts`.

## WebSocket Events

When a draft is created, approved, or rejected, system events are broadcast to all connected WebSocket clients:

```typescript
// Draft created
{ type: "system", subtype: "draft_created", message: "Draft response ready (a1b2c3d4)", data: { draftId: "...", platform: "slack-user", channelId: "...", preview: "..." } }

// Draft approved
{ type: "system", subtype: "draft_approved", message: "Draft a1b2c3d4 approved and sent", data: { draftId: "..." } }

// Draft rejected
{ type: "system", subtype: "draft_rejected", message: "Draft a1b2c3d4 rejected", data: { draftId: "..." } }
```

WebSocket clients can also send approval/rejection commands:

```typescript
// Approve a draft
{ type: "approve_draft", draftId: "full-uuid-here" }

// Reject a draft
{ type: "reject_draft", draftId: "full-uuid-here" }
```

## Database

User mode uses the unified `integrations` table and a `draft_messages` table:

```sql
-- Workspace tokens are stored in the integrations table as "slack-ws:{teamId}"
-- Secrets (xoxp- tokens) are encrypted at rest via AES-256-GCM
-- Example row:
--   name: "slack-ws:T01ABC"
--   secrets: { "access_token": "xoxp-..." }  (encrypted)
--   metadata: { "team_name": "My Company", "user_id": "U0ABC" }

-- Draft messages (for approve-before-send in daemon mode)
CREATE TABLE draft_messages (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform     TEXT NOT NULL,          -- "slack-user:T01ABC"
  channel_id   TEXT NOT NULL,          -- Slack channel ID
  thread_id    TEXT,                   -- thread_ts (if threaded)
  user_id      TEXT NOT NULL,          -- your Slack user ID
  in_reply_to  TEXT NOT NULL,          -- original message ID
  content      TEXT NOT NULL,          -- the drafted response
  context      JSONB NOT NULL,         -- metadata (sender, channel name, etc.)
  status       TEXT NOT NULL,          -- pending → approved/rejected → sent
  created_at   TIMESTAMPTZ NOT NULL,
  approved_at  TIMESTAMPTZ,
  sent_at      TIMESTAMPTZ,
  expires_at   TIMESTAMPTZ NOT NULL    -- 24h from creation
);
```

Status flow: `pending` → `approved` → `sent`, or `pending` → `rejected`.

### Token Storage

- **Database** is the source of truth — tokens encrypted at rest via AES-256-GCM in the `integrations` table (`slack-ws:{teamId}` naming)
- **`~/.nomos/slack/config.json`** is a plaintext runtime snapshot (0600 permissions) auto-synced from DB for `nomos-slack-mcp` to read
- Sync happens on workspace add/remove and on daemon startup

## Troubleshooting

### Adapter doesn't start

- If using OAuth: run `nomos slack workspaces` to verify stored tokens. Ensure `SLACK_APP_TOKEN` is set.
- If using env var: verify `SLACK_USER_TOKEN` and `SLACK_APP_TOKEN` are both set in `.env`
- Check that user tokens start with `xoxp-` (not `xoxb-`)
- Run `pnpm dev -- db migrate` to ensure tables exist

### No drafts created for DMs

- Confirm `message.im` is added under **Subscribe to events on behalf of users** (team events), not just under bot events
- Reinstall the app after adding team events
- Check daemon logs for `[slack-user-adapter]` messages

### No drafts created for @mentions

- The adapter listens for `<@YOUR_USER_ID>` in message text — this is your personal Slack user ID, not the bot's
- Make sure `message.channels` and `message.groups` team events are subscribed
- The user must be a member of the channel for events to fire

### Approve button doesn't work

- Interactivity must be enabled in the Slack app settings
- The bot adapter must be running (buttons are handled by the `SlackAdapter`, not the user adapter)
- Check daemon logs for action handler errors

### "not_in_channel" when sending approved message

The user token can only post to channels the user is a member of. Join the channel first.

### Draft appears but message sends as bot

Make sure you're using `/approve` in the CLI or the Slack button — both use the `xoxp-` user token. If the agent's response is going through the normal bot flow instead, check that the message came in on the `slack-user` platform (not `slack`).

## Security Considerations

- The `xoxp-` token has permissions tied to your personal Slack account. Treat it with the same care as your password.
- Drafts contain the full message content in the database. Ensure your PostgreSQL instance is secured.
- The approval flow is intentional — the agent never sends messages as you without explicit approval.
- Draft expiry (24h) limits the window of exposure for pending drafts.
- Only the authenticated user's DMs and mentions trigger drafts — the adapter filters out messages from the user themselves to prevent echo loops.
