# WhatsApp Integration

Connect Nomos to WhatsApp using the WhatsApp Web multi-device protocol. No Meta Business API, webhooks, or paid plans required — it works by linking to your WhatsApp account, the same way WhatsApp Web does.

## Prerequisites

- A phone with WhatsApp installed and an active account
- The Nomos daemon running (`pnpm daemon:dev` or `nomos daemon start`)
- Terminal access to scan the QR code on first run

## Step 1: Enable WhatsApp

Add this to your `.env` file in the `nomos/` directory:

```bash
WHATSAPP_ENABLED=true
```

That's the only required configuration. Authentication is handled via QR code.

### Optional: Restrict to Specific Chats

Limit the bot to certain contacts or groups:

```bash
WHATSAPP_ALLOWED_CHATS=15551234567@s.whatsapp.net,120363123456789012@g.us
```

**JID formats:**

- Individual chats: `<phone_number>@s.whatsapp.net` (e.g., `15551234567@s.whatsapp.net`)
- Group chats: `<group_id>@g.us` (e.g., `120363123456789012@g.us`)

Phone numbers use the international format without the `+` prefix.

## Step 2: Start the Daemon and Scan QR Code

```bash
# Development mode (foreground — required for first-time QR scanning)
pnpm daemon:dev
```

On first run, a QR code will be displayed in the terminal. To link:

1. Open WhatsApp on your phone
2. Go to **Settings** > **Linked Devices**
3. Tap **Link a Device**
4. Scan the QR code shown in the terminal

Once linked, you'll see:

```
[whatsapp-adapter] Running
[gateway]   Channels: whatsapp
```

## Step 3: Session Persistence

After the initial QR scan, authentication credentials are saved to:

```
~/.nomos/whatsapp-auth/
```

On subsequent daemon starts, the bot reconnects automatically without needing to scan again.

> **Important:** Back up the `~/.nomos/whatsapp-auth/` directory if you want to preserve the session across machine migrations.

## Usage

### Individual Chats

Send a message to the phone number linked to the daemon. The bot responds to all messages in individual chats.

### Group Chats

In groups, the bot responds when:

- **Mentioned** by phone number (e.g., `@15551234567`)
- The message **starts with** `/`, `!`, or `@`

This prevents the bot from responding to every message in busy group chats.

### Message Limits

WhatsApp has a 4,096-character message limit. Long responses are automatically split at natural break points.

## How It Works

The adapter uses the [Baileys](https://github.com/WhiskeySockets/Baileys) library, which implements WhatsApp's multi-device Web protocol:

- Connects as a linked device (like WhatsApp Web/Desktop)
- No server, webhook, or Meta Business API needed
- Messages are end-to-end encrypted as normal
- Works with personal WhatsApp accounts

The bot automatically:

- Ignores its own messages
- Ignores status/story broadcasts
- Reconnects after disconnections using saved credentials

## Troubleshooting

### QR code doesn't appear

- Make sure `WHATSAPP_ENABLED=true` is set in `.env`
- Run the daemon in foreground mode (`pnpm daemon:dev`) to see terminal output
- Check for errors in the daemon logs

### QR code expired

QR codes expire after a short time. If it expires, the adapter will generate a new one. If that doesn't work, restart the daemon.

### Bot disconnects frequently

- The primary phone must remain connected to the internet
- If the phone is offline for an extended period (14+ days), WhatsApp may unlink the device
- In that case, delete `~/.nomos/whatsapp-auth/` and re-scan the QR code

### "Connection Closed" errors

Common causes:

- Phone logged out of WhatsApp
- WhatsApp app updated and changed the protocol
- Too many linked devices (WhatsApp allows up to 4 linked devices)

To fix: delete `~/.nomos/whatsapp-auth/`, restart the daemon, and re-scan.

### Messages not received in groups

- Make sure the bot's phone number is a member of the group
- Messages must mention the bot's number or start with `/`, `!`, or `@`
- Check that `WHATSAPP_ALLOWED_CHATS` (if set) includes the group JID

### Finding Chat JIDs

To discover the JID for a chat:

1. Start the daemon with debug logging
2. Send a message in the target chat
3. Look for the chat ID in the daemon logs

Individual JIDs follow the pattern `<country_code><number>@s.whatsapp.net`.
Group JIDs follow the pattern `<creation_timestamp>-<creator_number>@g.us`.
