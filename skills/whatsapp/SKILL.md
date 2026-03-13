---
name: whatsapp
description: "Send WhatsApp messages programmatically via the Baileys library (WhatsApp Web multi-device protocol). Use when the user asks to send a WhatsApp message or interact with WhatsApp."
emoji: "📲"
---

# WhatsApp

Send and receive WhatsApp messages using the Baileys library, which implements the WhatsApp Web multi-device protocol.

## Authentication

The WhatsApp integration uses QR code authentication:

1. Run `npx tsx src/integrations/whatsapp.ts`
2. Scan the QR code with WhatsApp on your phone (Linked Devices)
3. Auth credentials are saved to `~/.nomos/whatsapp-auth/` for reconnection

## Running the Bot

Start the WhatsApp bot:

```bash
npx tsx src/integrations/whatsapp.ts
```

The bot will:

- Display a QR code on first run (scan with your phone)
- Automatically reconnect using saved credentials
- Listen for incoming messages in individual chats and groups
- Respond to mentions in groups or messages starting with `/`, `!`, or `@`
- Track conversation context for multi-turn dialogue

## Message Patterns

### Individual Chats

The bot responds to all messages in individual (1-on-1) chats.

### Group Chats

The bot only responds when:

1. **Mentioned by name** — Someone sends a message mentioning the bot's phone number
2. **Trigger prefix** — Message starts with `/`, `!`, or `@`

Example group messages that trigger a response:

```
@15551234567 what's the weather?
/help
!status
@bot hello there
```

## Restricting Access

To limit the bot to specific chats, set the `WHATSAPP_ALLOWED_CHATS` environment variable with comma-separated JIDs (WhatsApp IDs):

```bash
# .env
WHATSAPP_ALLOWED_CHATS=15551234567@s.whatsapp.net,120363123456789012@g.us
```

JID formats:

- Individual chats: `[phone_number]@s.whatsapp.net` (e.g., `15551234567@s.whatsapp.net`)
- Group chats: `[group_id]@g.us` (e.g., `120363123456789012@g.us`)

## Features

- **QR Code Login** — Scan with your phone to authenticate
- **Session Persistence** — Auth credentials saved for automatic reconnection
- **Multi-turn Context** — Maintains conversation history per chat
- **Group Support** — Responds to mentions and trigger prefixes in groups
- **Message Chunking** — Automatically splits long responses (4096 char limit)
- **Typing Indicators** — Shows "composing..." while processing
- **Allowlist Support** — Restrict bot to specific chats via env var

## Tips

- To find a chat JID, check the bot logs when a message is received
- Group JIDs contain `@g.us`, individual chats contain `@s.whatsapp.net`
- In groups, prefix messages with `/`, `!`, or `@` to trigger the bot without mentioning
- The bot ignores its own messages and status broadcasts
- Long messages are automatically split into multiple messages
- Auth state is stored in `~/.nomos/whatsapp-auth/` — back up this directory to preserve sessions
