# Data Ingestion Pipeline

Nomos can ingest years of historical communications from Slack, Gmail, iMessage, and WhatsApp to build deep context for the digital clone.

## Overview

The ingestion pipeline reads messages from external sources, deduplicates them, chunks the text, generates embeddings, and stores everything in pgvector-backed memory. After initial ingestion, continuous delta sync keeps the knowledge base current.

## Supported Platforms

| Platform     | Source                 | What's ingested                                    | Cursor for delta sync   |
| ------------ | ---------------------- | -------------------------------------------------- | ----------------------- |
| **Slack**    | `@slack/web-api`       | Sent messages only (matches authenticated user ID) | Slack pagination cursor |
| **Gmail**    | Gmail API              | Sent folder only (`in:sent`)                       | Gmail `historyId`       |
| **iMessage** | macOS `chat.db` SQLite | Both directions (style trains on sent only)        | Last ROWID              |
| **WhatsApp** | Standard `.txt` export | Both directions (style trains on sent only)        | File-based, no delta    |

## CLI Usage

```bash
# Ingest from a specific platform
nomos ingest <slack|gmail|imessage|whatsapp> [options]

# Options
--since DATE        Only messages after this date (default: 6 months ago)
--contact NAME      Filter to a specific contact
--dry-run           Preview without storing
--analyze-style     Run style analysis after ingestion

# Check status of all ingest jobs
nomos ingest status
```

### Examples

```bash
# Import 2 years of iMessage history
nomos ingest imessage --since 2024-01-01

# Dry run Slack ingestion for a specific contact
nomos ingest slack --contact "Sarah Chen" --dry-run

# Import WhatsApp export file
nomos ingest whatsapp --file ~/Downloads/WhatsApp\ Chat.txt

# Check progress
nomos ingest status
```

## How It Works

### Pipeline stages

1. **Source** — Platform-specific adapter reads messages as an async generator
2. **Dedup** — SHA-256 hash of `(platform + contact + timestamp + content)` checked against `memory_chunks.hash`
3. **Chunk** — Uses existing `chunkText()` from `src/memory/chunker.ts` with overlap
4. **Embed** — Batch embeddings via `generateEmbeddings()` (max batch size: 250)
5. **Store** — Written to `memory_chunks` with metadata: `{ source: "ingest", platform, direction, contact }`

### Filtering strategy

The style model trains exclusively on `metadata->>'direction' = 'sent'` regardless of what's ingested. Received messages provide conversation context but don't influence voice modeling.

- **Slack/Gmail:** Only sent messages are ingested to avoid noise from spam, newsletters, etc.
- **iMessage/WhatsApp:** Both directions ingested for conversation context, but style analysis uses sent only.

## Delta Sync

After initial ingestion completes, a cron job is automatically registered for continuous sync:

| Platform | Default interval | Cursor type             |
| -------- | ---------------- | ----------------------- |
| Slack    | Every 6 hours    | Slack pagination cursor |
| Gmail    | Every 6 hours    | Gmail `historyId`       |
| iMessage | Every 1 hour     | Last ROWID              |
| WhatsApp | Manual only      | File-based              |

Delta sync uses the `last_cursor` from the `ingest_jobs` table to fetch only new messages since the last successful run.

### Configuration

- `app.ingestDeltaInterval` — Default delta sync interval (default: `"6h"`)
- Per-job toggle via `delta_enabled` column in `ingest_jobs`

## Rate Limiting

| Platform                      | Limit               | Strategy                                      |
| ----------------------------- | ------------------- | --------------------------------------------- |
| Slack `conversations.history` | ~50 req/min         | Exponential backoff, 1.2s delay between pages |
| Gmail API                     | 250 quota units/sec | Batch API calls, respect 429 responses        |
| iMessage                      | Local SQLite        | Batch 1000 rows per query                     |
| WhatsApp                      | Local file          | Stream-parse line by line                     |

## Settings UI

The ingestion dashboard is at `/admin/ingestion` in the Settings UI:

- Per-platform sync status cards with last sync time and message counts
- Trigger manual sync
- View errors
- Toggle delta sync per platform

## Database

### `ingest_jobs` table

| Column               | Type    | Description                         |
| -------------------- | ------- | ----------------------------------- |
| `platform`           | TEXT    | slack, gmail, imessage, whatsapp    |
| `status`             | TEXT    | running, completed, failed          |
| `messages_processed` | INT     | Total messages stored               |
| `messages_skipped`   | INT     | Duplicates skipped                  |
| `last_cursor`        | TEXT    | Platform-specific pagination cursor |
| `delta_schedule`     | TEXT    | Cron/interval for delta sync        |
| `delta_enabled`      | BOOLEAN | Whether delta sync is active        |

## Troubleshooting

### iMessage: Permission denied

Grant Full Disk Access to your terminal in System Settings > Privacy & Security.

### Slack: Rate limited

The pipeline includes exponential backoff. Large history imports may take time. Check `ingest_jobs.error` for details.

### Gmail: OAuth token expired

Re-authenticate via Settings UI at `/integrations/email` or refresh the token in the `integrations` table.
