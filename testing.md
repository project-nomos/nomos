# Digital Clone Testing Guide

Step-by-step instructions to verify the digital clone features (P0-P3) from a fresh database.

---

## Prerequisites

```bash
pnpm install
pnpm build
pnpm test                        # 249 tests should pass
pnpm check                      # format + typecheck + lint
```

Ensure `DATABASE_URL` is set and PostgreSQL has the `pgvector` extension.

---

## 1. Fresh Database Setup

```bash
pnpm dev -- db migrate
```

**Verify:** All new tables created without errors:

- `ingest_jobs` (P0a)
- `style_profiles` (P0b)
- `wiki_articles` (P0c)
- `contacts`, `contact_identities` (P1c)
- `commitments` (P2b)

```sql
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public'
ORDER BY table_name;
```

---

## 2. Setup Wizard (Onboarding)

```bash
pnpm dev -- chat
```

The first-run wizard should open in the browser at `http://localhost:3456/setup`.

**Verify the 6-step wizard:**

1. Database
2. API
3. Identity
4. Channels — after saving credentials, should show "Import sent messages" toggle + date range picker
5. **Data Sync** (NEW) — shows ingestion progress for configured channels, "Skip for now" option
6. Ready

---

## 3. Ingestion Pipeline (P0a)

Start with iMessage (local, no API keys, macOS only — requires Full Disk Access in System Settings > Privacy):

```bash
# Preview without storing
pnpm dev -- ingest imessage --since 2024-01-01 --dry-run

# Actual ingest
pnpm dev -- ingest imessage --since 2024-01-01

# Check job status
pnpm dev -- ingest status
```

**Verify:**

- Messages are chunked, embedded, and stored in `memory_chunks` with `metadata->>'source' = 'ingest'`
- `ingest_jobs` table has a row with `status = 'completed'`, `messages_processed > 0`
- Deduplication works: running the same ingest again should show `messages_skipped` increase

If Slack is configured:

```bash
pnpm dev -- ingest slack --since 2024-06-01
pnpm dev -- ingest status
```

**Verify sent-only filtering:** Slack ingestion should only store messages sent by the authenticated user.

```sql
SELECT platform, status, messages_processed, messages_skipped, last_cursor
FROM ingest_jobs ORDER BY started_at DESC;
```

---

## 4. Contacts & Identity Graph (P1c)

After ingestion, contacts should be auto-linked:

```bash
pnpm dev -- contacts list
pnpm dev -- contacts list --platform imessage
pnpm dev -- contacts show <contact-id>
```

**Verify:**

- Contacts are created from ingested messages
- `contact_identities` links platform user IDs to contacts
- Auto-linker merges contacts with matching display names across platforms

Manual linking test:

```bash
pnpm dev -- contacts link <contact-id> slack U12345678
pnpm dev -- contacts show <contact-id>   # should show both identities
pnpm dev -- contacts unlink <identity-id>
```

---

## 5. Style Model (P0b)

After ingestion has populated sent messages:

```bash
# Trigger style analysis (done automatically after ingest with --analyze-style)
pnpm dev -- ingest imessage --since 2024-01-01 --analyze-style
```

**Verify:**

```sql
-- Global style profile
SELECT scope, sample_count, profile FROM style_profiles WHERE contact_id IS NULL;

-- Per-contact profiles
SELECT c.display_name, sp.scope, sp.sample_count, sp.profile
FROM style_profiles sp
JOIN contacts c ON c.id = sp.contact_id
ORDER BY sp.sample_count DESC;
```

Expected profile fields: `formality` (1-5), `avg_length`, `emoji_usage`, `greeting_patterns`, `signoff_patterns`.

---

## 6. Knowledge Wiki (P0c)

The knowledge compiler runs via cron (every 2h) or on-demand:

**Verify after some time / manual trigger:**

```sql
SELECT path, title, category, word_count, compiled_at
FROM wiki_articles ORDER BY compiled_at DESC;
```

Check disk sync:

```bash
ls -la ~/.nomos/wiki/
ls -la ~/.nomos/wiki/contacts/
ls -la ~/.nomos/wiki/topics/
```

**Verify:**

- Articles exist in both DB and `~/.nomos/wiki/`
- `_index.md` files contain summaries and backlinks
- Contact articles reference ingested communication data

---

## 7. CATE Protocol (P3)

### Server startup

```bash
pnpm dev -- daemon run
```

**Verify in logs:**

```
[cate] Generated new agent key pair
[cate] Generated new user key pair
[cate] Transport listening on port 8801
[cate] Server started on port 8801 (DID: did:key:z6Mk...)
```

### Send a test envelope

In another terminal:

```bash
curl -X POST http://localhost:8801/cate \
  -H "Content-Type: application/json" \
  -d '{
    "header": {
      "msg_id": "test-001",
      "created_at": "2026-04-07T00:00:00Z",
      "sender": {"did": "did:key:z6MkTest"},
      "recipient": {"did": "did:key:z6MkTest2"}
    },
    "policy": {
      "intent": "personal"
    },
    "payload": {
      "content": "Hello from a test agent"
    }
  }'
```

**Expected:** `{"status":"accepted"}` (200 OK).

**Verify in daemon logs:**

```
[cate] Received envelope from did:key:z6MkTest (unknown, allow)
```

### Verify keystore persistence

```sql
SELECT name, config FROM integrations WHERE name LIKE 'cate-key:%';
```

Should show `cate-key:nomos-agent` and `cate-key:nomos-user` with encrypted secrets.

---

## 8. Passive Observation Mode (P1b)

Requires Slack configured. Enable observation on specific channels:

Set config:

```sql
INSERT INTO config (key, value) VALUES
  ('observe.slack-user:TEAM_ID.channels', '["C_CHANNEL_ID"]')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
```

**Verify:** With daemon running, messages in observed channels are indexed into memory but do NOT trigger agent responses.

---

## 9. Draft Manager with Autonomy (P2a)

Set a contact's autonomy level:

```sql
UPDATE contacts SET autonomy = 'auto' WHERE display_name = 'Test Contact';
```

**Verify:**

- `auto` — messages to this contact are sent immediately (no draft)
- `draft` (default) — messages create a draft for approval
- `silent` — messages are discarded

```bash
pnpm dev -- chat
# In daemon mode, send a message to a contact with each autonomy level
```

---

## 10. Proactive Agency (P2b)

### Commitment tracking

After conversations where commitments are made ("I'll send you the report by Friday"), verify:

```sql
SELECT description, deadline, status FROM commitments ORDER BY created_at DESC;
```

### Meeting briefs

Requires Google Calendar configured. Verify pre-meeting context generation.

### Priority triage

Verify cross-channel unread aggregation and ranking by sender importance.

---

## 11. Email Channel (P1a)

Requires IMAP/SMTP credentials in the `integrations` table:

```sql
INSERT INTO integrations (name, enabled, config, secrets) VALUES (
  'email', true,
  '{"imap_host":"imap.gmail.com","imap_port":993,"smtp_host":"smtp.gmail.com","smtp_port":587}',
  '<encrypted credentials>'
);
```

**Verify:**

- Daemon logs show IMAP IDLE connection
- Incoming emails appear as messages in the daemon
- Outgoing replies route through draft manager

---

## 12. Settings UI

```bash
cd settings && pnpm dev
```

Check these pages at `http://localhost:3456`:

| Page               | What to verify                                                       |
| ------------------ | -------------------------------------------------------------------- |
| `/setup`           | 6-step wizard with Data Sync step                                    |
| `/admin/ingestion` | Per-platform sync status, message counts, trigger sync, delta toggle |
| `/admin/proactive` | Commitment list, triage config, meeting brief settings               |
| `/integrations`    | Channel cards including email                                        |

### Ingestion API

```bash
# Get all ingest jobs
curl http://localhost:3456/api/ingestion

# Trigger a sync
curl -X POST http://localhost:3456/api/ingestion -H "Content-Type: application/json" \
  -d '{"platform": "imessage"}'
```

---

## 13. Delta Sync (Continuous Ingestion)

After initial ingest completes, a cron job should auto-register:

```sql
SELECT name, schedule, enabled FROM cron_jobs WHERE name LIKE 'ingest-delta:%';
```

**Verify:**

- Default schedule: every 6h for Slack/Gmail, every 1h for iMessage
- Delta sync uses `last_cursor` from `ingest_jobs` (Slack cursor, Gmail historyId, iMessage ROWID)
- Running the delta job only processes new messages since last run

---

## Quick Smoke Test Checklist

| #   | Test                   | Command                                                    | Pass criteria                        |
| --- | ---------------------- | ---------------------------------------------------------- | ------------------------------------ |
| 1   | DB migrations          | `pnpm dev -- db migrate`                                   | No errors, 6 new tables              |
| 2   | iMessage ingest        | `pnpm dev -- ingest imessage --since 2024-01-01 --dry-run` | Shows message count                  |
| 3   | Contacts auto-created  | `pnpm dev -- contacts list`                                | Contacts from ingested data          |
| 4   | CATE server starts     | `pnpm dev -- daemon run`                                   | `[cate] Server started on port 8801` |
| 5   | CATE envelope accepted | `curl -X POST localhost:8801/cate ...`                     | `{"status":"accepted"}`              |
| 6   | Ingest status          | `pnpm dev -- ingest status`                                | Job rows with counts                 |
| 7   | Settings UI            | `cd settings && pnpm dev`                                  | `/admin/ingestion` renders           |
| 8   | Setup wizard           | Visit `/setup`                                             | Shows 6 steps                        |
| 9   | Style profiles         | `SELECT * FROM style_profiles`                             | At least global profile              |
| 10  | Wiki articles          | `SELECT * FROM wiki_articles`                              | Articles after compilation           |

---

## Troubleshooting

### iMessage: "Permission denied" reading chat.db

Grant Full Disk Access to your terminal app in System Settings > Privacy & Security > Full Disk Access.

### CATE: "CATE key not found"

The keystore stores keys in the `integrations` table. Verify DB connection and that migrations ran.

### Ingestion: "Rate limited"

Slack and Gmail have API rate limits. The pipeline includes exponential backoff, but large history imports may take time. Check `ingest_jobs.error` for details.

### Style model: No profiles generated

Style analysis requires sent messages (`metadata->>'direction' = 'sent'`). Verify ingestion completed and messages have the correct direction metadata.

### Wiki: Empty ~/.nomos/wiki/

Knowledge compilation runs on a cron schedule (default: every 2h). Check `wiki_articles` table — if populated, disk sync may need a daemon restart.
