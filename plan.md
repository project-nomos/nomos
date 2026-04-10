# Digital Clone Implementation Plan

## Context

Nomos currently learns only from direct interactions (conversations where the user asks it to do things). To become a true "digital clone," it needs to learn from **observations of the user** — ingesting historical communications, modeling writing style per contact, building a unified identity graph, and eventually implementing a trust protocol (CATE) for secure agent-to-agent communication. This plan covers P0 through P3 execution.

---

## Cross-Cutting: Settings UI + Onboarding + Auto-Sync

These concerns apply across all phases and are called out here to avoid repetition.

### Settings UI Pages (Next.js, `settings/src/app/`)

New pages follow the existing pattern (e.g., `integrations/slack/page.tsx`):

| Page                                           | Phase | Description                                                                                                                                        |
| ---------------------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `settings/src/app/admin/ingestion/page.tsx`    | P0a   | Ingestion dashboard: per-platform sync status, last sync time, message counts, trigger manual sync, view errors. Shows `ingest_jobs` table data    |
| `settings/src/app/admin/style/page.tsx`        | P0b   | Style model viewer: global profile preview, per-contact style breakdown, sample messages, re-analyze button                                        |
| `settings/src/app/admin/contacts/page.tsx`     | P1c   | Contact management: list contacts with linked identities, merge/split, set autonomy levels (auto/draft/silent), relationship tags. Search + filter |
| `settings/src/app/integrations/email/page.tsx` | P1a   | Email integration config: IMAP/SMTP settings, Gmail OAuth, test connection, enable/disable                                                         |
| `settings/src/app/settings/page.tsx` (modify)  | P1b   | Add "Passive Observation" toggle + channel selector to existing settings page                                                                      |
| `settings/src/app/admin/proactive/page.tsx`    | P2b   | Proactive features: commitment list, triage config, meeting brief settings, enable/disable                                                         |

Each page needs a corresponding API route in `settings/src/app/api/`:

- `api/ingestion/route.ts` — GET status, POST trigger sync
- `api/ingestion/[platform]/route.ts` — per-platform sync control
- `api/contacts/route.ts` — CRUD contacts
- `api/contacts/[id]/route.ts` — single contact ops
- `api/style/route.ts` — GET profiles, POST re-analyze
- `api/email/route.ts` — email integration config

### Onboarding Flow Changes (`settings/src/app/setup/`)

The setup wizard currently has 5 steps: Database → API → Identity → Channels → Ready.

**Modified step: Channels** (`setup/steps/channels.tsx`)

- After saving channel credentials, show a "Sync History" prompt: "Would you like to import your message history? This helps Nomos learn your communication style."
- Per-channel toggle: "Import sent messages" (default: on)
- Date range picker: "Import messages since: [date]" (default: 6 months ago)
- On "Next", trigger background ingestion job via `POST /api/ingestion/[platform]`

**New step: Data Sync** (insert between Channels and Ready)

- `setup/steps/data-sync.tsx` — Shows ingestion progress for all configured channels
- Live progress bars (poll `GET /api/ingestion` every 2s)
- "Skip for now" option (can do later from Settings)
- Moves to Ready when all jobs complete or skipped

Update `setup/page.tsx` STEPS array:

```typescript
const STEPS = [
  { label: "Database", number: 1 },
  { label: "API", number: 2 },
  { label: "Identity", number: 3 },
  { label: "Channels", number: 4 },
  { label: "Data Sync", number: 5 }, // NEW
  { label: "Ready", number: 6 },
];
```

### Auto-Ingest on Channel Connect + Continuous Delta Sync

**Auto-ingest trigger:** When a channel integration is saved (via Settings UI or onboarding), the API route calls `POST /api/ingestion/[platform]` to start a background ingestion job. This is the same endpoint used by the CLI `nomos ingest` command.

**Continuous delta sync** via the existing `CronEngine`:

- When ingestion completes, automatically register a cron job: `ingest-delta:[platform]`
- Default schedule: every 6 hours for Slack/Gmail, every 1 hour for iMessage (local, cheap)
- Delta sync uses `last_cursor` from `ingest_jobs` table (Slack cursor, Gmail historyId, iMessage last ROWID)
- Config key: `app.ingestDeltaInterval` (default: `"6h"`)
- The cron job calls the same `IngestSource.ingest()` with `since` set to last successful run's timestamp

**`ingest_jobs` table update** — add columns for delta tracking:

```sql
last_successful_at  TIMESTAMPTZ,  -- when last delta completed
delta_schedule      TEXT,          -- cron expression or interval
delta_enabled       BOOLEAN NOT NULL DEFAULT true
```

### Ingestion Filtering Strategy

| Platform     | What to ingest                                                  | Why                                                                     |
| ------------ | --------------------------------------------------------------- | ----------------------------------------------------------------------- |
| **Slack**    | Sent messages only (`user` field matches authenticated user ID) | Your words, not others'. Context comes from passive observation (P1b)   |
| **Gmail**    | Sent folder only (`in:sent`)                                    | Avoids spam, newsletters, promotions entirely                           |
| **iMessage** | Both directions (`is_from_me=0` and `is_from_me=1`)             | Need received for conversation context. Style model trains on sent only |
| **WhatsApp** | Both directions (from export)                                   | Same as iMessage — context from received, style from sent               |

Style model always trains exclusively on `metadata->>'direction' = 'sent'` regardless of what's ingested.

### pgvector + Compiled Knowledge Wiki (Hybrid Approach)

**Vector DB decision:** Stay with pgvector, upgrade to HNSW index. But pure RAG is not enough — adopt Karpathy's "LLM Knowledge Base" pattern as a compiled layer on top.

**The insight:** At personal scale (~100K messages), a structured markdown wiki compiled by an LLM is more effective than raw vector search. The wiki provides _synthesized understanding_, while RAG provides _raw recall_. Nomos already has primitives for this (auto-dream consolidation, magic docs), but they need to be expanded into a full knowledge compilation system.

**Hybrid architecture:**

1. **Layer 1: Raw ingestion → pgvector** (existing) — chunked messages stored with embeddings for fuzzy search
2. **Layer 2: Compiled wiki → `~/.nomos/wiki/`** (new) — LLM-compiled markdown articles organized by topic
3. **Layer 3: Knowledge graph → `contacts` + `relationships`** (new in P1c) — structured relationship data

**Wiki compilation pipeline** (new module `src/memory/knowledge-compiler.ts`):

- Runs periodically via cron (like auto-dream, but for knowledge synthesis)
- Reads recent ingested messages + existing wiki articles
- Compiles/updates topic articles: `contacts/sarah.md`, `projects/q2-launch.md`, `topics/kubernetes.md`
- Auto-maintains `_index.md` files with summaries and backlinks
- Agent reads wiki articles first (cheap, structured), falls back to RAG search for details
- Wiki is the LLM's domain — user rarely touches it directly

**Why not a graph DB?** A full graph DB (Neo4j, etc.) adds infrastructure complexity. The contacts/relationship tables in PostgreSQL + the compiled wiki give us 90% of graph query capability. The wiki articles create implicit graph edges through backlinks and cross-references. If we outgrow this, can add `pg_graphql` extension to PostgreSQL later.

**pgvector index upgrade:**

- IVFFlat → HNSW (`CREATE INDEX ... USING hnsw (embedding vector_cosine_ops)`)
- Better recall, no tuning needed
- Single-user scale is well within pgvector's sweet spot

---

## P0a: Historical Data Ingestion Pipeline

**Goal:** Ingest years of Slack, Gmail, iMessage, and WhatsApp history into vector memory so the clone has deep context.

### New files

| File                             | LOC  | Description                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | -------- | ------------------------------------------------------------------------------------------------- |
| `src/ingest/types.ts`            | ~60  | `IngestSource` interface (AsyncGenerator-based), `IngestMessage`, `IngestOptions`, `IngestProgress`                                                                                                                                                                                                                                                            |
| `src/ingest/pipeline.ts`         | ~200 | Orchestrator: dedup → chunk → embed → store. Uses existing `chunkText()` from `src/memory/chunker.ts`, `generateEmbeddings()` from `src/memory/embeddings.ts`, `storeMemoryChunk()` from `src/db/memory.ts`. Metadata: `{ source: "ingest", platform, direction, contact }`. Batch embeddings (MAX_BATCH_SIZE=250). Progress tracking via `ingest_jobs` table. |
| `src/ingest/dedup.ts`            | ~60  | SHA-256 hash of `(platform + contact + timestamp + content)`, batch check against `memory_chunks.hash`                                                                                                                                                                                                                                                         |
| `src/ingest/sources/slack.ts`    | ~250 | Uses `@slack/web-api` `conversations.history` + `conversations.list`. **Filters to sent messages only** (matches authenticated user ID). Cursor pagination (cursor saved to `ingest_jobs.last_cursor` for delta sync). User name cache (pattern from `slack-user.ts:203-215`). Token from `listWorkspaces()` in `src/db/slack-workspaces.ts`                   |
| `src/ingest/sources/imessage.ts` | ~200 | Extends `imessage-db.ts` pattern — bulk query of `message` table (both `is_from_me=0` and `is_from_me=1`). Tags `direction` field. Saves last ROWID as cursor for delta sync. Reuses `appleTimestampToDate()`. Date filter support                                                                                                                             |
| `src/ingest/sources/gmail.ts`    | ~250 | Gmail API via `google-auth-library` (already a dep). **Queries `in:sent` only**. Saves `historyId` as cursor for delta sync. Thread preservation via Gmail thread IDs                                                                                                                                                                                          |
| `src/ingest/sources/whatsapp.ts` | ~180 | Parses standard WhatsApp `.txt` export format. File-based, no API                                                                                                                                                                                                                                                                                              |
| `src/cli/ingest.ts`              | ~180 | CLI: `nomos ingest <slack                                                                                                                                                                                                                                                                                                                                      | gmail | imessage | whatsapp> [--since DATE] [--contact NAME] [--dry-run]`, `nomos ingest status`. Progress via chalk |

### Modified files

| File                 | Change                                                                   |
| -------------------- | ------------------------------------------------------------------------ |
| `src/cli/program.ts` | Add `registerIngestCommand(program)` (2 lines, follows existing pattern) |
| `src/db/schema.sql`  | Add `ingest_jobs` table (below)                                          |

### New DB table

```sql
CREATE TABLE IF NOT EXISTS ingest_jobs (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform            TEXT NOT NULL,
  source_type         TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'running',
  contact             TEXT,
  since_date          TIMESTAMPTZ,
  messages_processed  INT NOT NULL DEFAULT 0,
  messages_skipped    INT NOT NULL DEFAULT 0,
  last_cursor         TEXT,
  error               TEXT,
  started_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at         TIMESTAMPTZ,
  last_successful_at  TIMESTAMPTZ,
  delta_schedule      TEXT DEFAULT '6h',
  delta_enabled       BOOLEAN NOT NULL DEFAULT true,
  UNIQUE (platform, source_type, contact)
);
CREATE INDEX IF NOT EXISTS idx_ingest_status ON ingest_jobs(status);
```

Also add HNSW index migration:

```sql
-- Upgrade vector index from IVFFlat to HNSW (better recall, no tuning needed)
DROP INDEX IF EXISTS idx_memory_vector;
CREATE INDEX IF NOT EXISTS idx_memory_vector_hnsw ON memory_chunks
  USING hnsw (embedding vector_cosine_ops);
```

### Additional files for auto-sync + Settings UI

| File                                                 | LOC  | Description                                                                                                                                                     |
| ---------------------------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/ingest/delta-sync.ts`                           | ~120 | Registers cron jobs for continuous delta ingestion. Called after initial ingest completes. Uses `CronEngine` pattern. Reads `delta_schedule` from `ingest_jobs` |
| `settings/src/app/admin/ingestion/page.tsx`          | ~300 | Ingestion dashboard: per-platform status cards, last sync, counts, trigger sync, errors, delta toggle                                                           |
| `settings/src/app/api/ingestion/route.ts`            | ~80  | GET all ingest jobs, POST trigger new ingest                                                                                                                    |
| `settings/src/app/api/ingestion/[platform]/route.ts` | ~60  | Per-platform sync control (trigger, pause, configure delta interval)                                                                                            |
| `settings/src/app/setup/steps/data-sync.tsx`         | ~200 | Onboarding step: shows ingestion progress after channel config, skip option                                                                                     |

### Modified files (additional)

| File                                        | Change                                                                                                                              |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `settings/src/app/setup/page.tsx`           | Add step 5 "Data Sync" between Channels and Ready. Update STEPS array (6 steps total)                                               |
| `settings/src/app/setup/steps/channels.tsx` | After saving credentials, show "Import sent messages" toggle + date range picker. On Next, trigger `POST /api/ingestion/[platform]` |
| `src/daemon/gateway.ts`                     | After channel adapter starts successfully, check if initial ingest exists for that platform. If not, auto-trigger background ingest |

### New config keys

- `app.ingestDeltaInterval` — default delta sync interval (default: `"6h"`)

### New deps: None (all packages already in package.json)

### Complexity: **XL** (upgraded from L due to Settings UI + onboarding + auto-sync)

---

## P0b: Communication Style Model

**Goal:** Analyze the user's sent messages to learn their writing voice — globally and per contact.

### New files

| File                         | LOC  | Description                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/memory/style-model.ts`  | ~350 | Queries `memory_chunks` for `metadata->>'source' = 'ingest' AND metadata->>'direction' = 'sent'`. Batches by contact. Uses `runForkedAgent()` (Haiku) to extract: formality (1-5), avg length, vocabulary, emoji usage, punctuation, greeting/signoff patterns. Produces `StyleProfile` stored as JSONB. Global profile (contact_id=NULL) + per-contact overrides |
| `src/memory/style-prompt.ts` | ~100 | Converts `StyleProfile` → natural-language prompt instructions. Merges global + per-contact (contact overrides). Example: "Write casually, lowercase, 1-2 emojis, under 50 words"                                                                                                                                                                                 |
| `src/db/style-profiles.ts`   | ~80  | CRUD for `style_profiles` table. Pattern follows `src/db/user-model.ts`                                                                                                                                                                                                                                                                                           |

### Modified files

| File                          | Change                                                                                             |
| ----------------------------- | -------------------------------------------------------------------------------------------------- |
| `src/db/schema.sql`           | Add `style_profiles` table (below)                                                                 |
| `src/config/profile.ts`       | Add `styleGuidance?: string` to `buildSystemPromptAppend()` params; insert style block into prompt |
| `src/daemon/agent-runtime.ts` | In `processMessage()`, load style profile for contact, pass as `styleGuidance`                     |
| `src/ingest/pipeline.ts`      | After ingestion, optionally trigger style analysis (`--analyze-style` flag)                        |

### New DB table

```sql
CREATE TABLE IF NOT EXISTS style_profiles (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id   UUID REFERENCES contacts(id) ON DELETE CASCADE,
  scope        TEXT NOT NULL DEFAULT 'global',
  profile      JSONB NOT NULL DEFAULT '{}',
  sample_count INT NOT NULL DEFAULT 0,
  last_updated TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (contact_id, scope)
);
CREATE INDEX IF NOT EXISTS idx_style_contact ON style_profiles(contact_id);
```

Note: `contact_id` is nullable initially (for global profile). FK to `contacts` table added in P1c migration.

### Complexity: **L**

---

## P0c: Personal Knowledge Wiki (Karpathy-style Knowledge Compilation)

**Goal:** Compile raw ingested messages into a structured, LLM-maintained markdown wiki that becomes the agent's primary knowledge surface.

### Architecture

```
Raw messages (pgvector)  →  Knowledge Compiler (LLM)  →  Wiki (~/.nomos/wiki/)
                                    ↑                          ↓
                              Periodic cron job          Agent reads wiki first,
                              (every 2h or on-demand)    falls back to RAG
```

The wiki is organized as:

```
~/.nomos/wiki/
  _index.md              # Master index with all article summaries
  contacts/
    _index.md            # Contact directory
    sarah-chen.md        # Everything about Sarah: role, comms style, topics, recent
    john-doe.md
  topics/
    _index.md
    kubernetes.md        # Cross-contact topic synthesis
    q2-launch.md
  style/
    _index.md
    global-voice.md      # Compiled writing style guide
    formal-emails.md     # Context-specific style
  timeline/
    2026-04.md           # Monthly activity digest
```

### Storage: DB-primary, disk-as-cache

Wiki articles are stored in a `wiki_articles` DB table (source of truth) and synced to `~/.nomos/wiki/` as a readable cache. Disk loss = cheap re-sync from DB. No LLM re-compilation needed.

```sql
CREATE TABLE IF NOT EXISTS wiki_articles (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  path         TEXT UNIQUE NOT NULL,       -- e.g. 'contacts/sarah-chen.md'
  title        TEXT NOT NULL,
  content      TEXT NOT NULL,
  category     TEXT NOT NULL,              -- 'contact', 'topic', 'style', 'timeline', 'index'
  backlinks    TEXT[] NOT NULL DEFAULT '{}', -- paths of articles that link here
  word_count   INT NOT NULL DEFAULT 0,
  compile_model TEXT,                      -- model used for last compilation
  compiled_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wiki_category ON wiki_articles(category);
CREATE INDEX IF NOT EXISTS idx_wiki_path ON wiki_articles(path);
```

Disk sync: after each DB write, also write to `~/.nomos/wiki/{path}`. On startup, if disk is empty/stale, bulk-sync from DB. The disk copy exists so the user can browse in Obsidian/VS Code and so the agent can read files directly.

### New files

| File                               | LOC  | Description                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/memory/knowledge-compiler.ts` | ~350 | Core compiler. Queries recent `memory_chunks` since last compilation. Groups by contact + topic. Uses `runForkedAgent()` (Sonnet for quality) to compile/update wiki articles. Writes to `wiki_articles` table + syncs to disk. Maintains `_index.md` files with summaries + backlinks. Lock-file coordination (same pattern as `auto-dream.ts`). Runs via cron or on-demand |
| `src/memory/wiki-reader.ts`        | ~150 | Reads wiki articles for injection into agent context. `getRelevantArticles(query)` — reads `_index.md` from DB, identifies relevant articles by topic/contact, returns content. Used by agent-runtime before falling back to vector search                                                                                                                                   |
| `src/memory/wiki-sync.ts`          | ~100 | Syncs `wiki_articles` table ↔ `~/.nomos/wiki/` disk. `syncToDb()` (for user edits on disk), `syncToDisk()` (after compilation). Startup reconciliation                                                                                                                                                                                                                       |
| `src/memory/wiki-health.ts`        | ~100 | "Linting" pass — finds inconsistent data, stale articles, missing backlinks, suggests new article candidates. Runs as a periodic health check via cron                                                                                                                                                                                                                       |
| `src/db/wiki.ts`                   | ~80  | CRUD for `wiki_articles` table. `upsertArticle()`, `getArticle()`, `listArticles()`, `searchArticles()`                                                                                                                                                                                                                                                                      |

### Modified files

| File                          | Change                                                                                             |
| ----------------------------- | -------------------------------------------------------------------------------------------------- |
| `src/daemon/agent-runtime.ts` | Before vector search, check wiki for relevant articles via `wiki-reader.ts`. Inject as context     |
| `src/sdk/tools.ts`            | Add `wiki_search` MCP tool alongside existing `memory_search` — searches wiki articles from DB     |
| `src/daemon/gateway.ts`       | Register knowledge compiler cron job on startup (default: every 2h). Run wiki disk sync on startup |
| `src/db/schema.sql`           | Add `wiki_articles` table                                                                          |

### New config keys

- `app.wikiEnabled` — enable/disable knowledge compilation (default: `true`)
- `app.wikiCompileInterval` — compilation interval (default: `"2h"`)
- `app.wikiCompileModel` — model for compilation (default: `"claude-sonnet-4-6"` — quality matters here)

### Relationship to existing systems

- **auto-dream** consolidates _conversation memory_ (what the agent discussed with the user)
- **knowledge-compiler** compiles _ingested communications_ (what the user said to others) into structured articles
- **magic-docs** auto-updates _project documentation_ — different scope, same update pattern
- All three can coexist — they serve different knowledge layers

### Complexity: **L**

---

## P1a: Email Channel Adapter

**Goal:** Real-time inbox monitoring with draft-and-approve for replies, like Slack User Mode but for email.

### New files

| File                                | LOC  | Description                                                                                                                                                                                                                                                                     |
| ----------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/daemon/channels/email.ts`      | ~350 | Implements `ChannelAdapter`. IMAP IDLE for real-time push. Thread tracking via `In-Reply-To`/`References` headers → `threadId`. `send()` routes through `DraftManager` (pattern from `slack-user.ts:116-125`). After approval, sends via SMTP. Config from `integrations` table |
| `src/daemon/channels/email-imap.ts` | ~200 | IMAP connection management, IDLE loop, message fetch/parse. Separated for 500 LOC limit                                                                                                                                                                                         |
| `src/daemon/channels/email-smtp.ts` | ~100 | SMTP send via `nodemailer`. HTML-to-text for LLM, text-to-HTML for sending                                                                                                                                                                                                      |

### Modified files

| File                    | Change                                                                                                                                                     |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/daemon/gateway.ts` | Add email adapter registration in `registerChannelAdapters()` (lines 499-643), guarded by `integrations` table check. Register send fn with `DraftManager` |

### New config: Stored in `integrations` table (name: `email`):

- config: `{ imap_host, imap_port, smtp_host, smtp_port }`
- secrets (encrypted): `{ username, password }` or OAuth tokens

### New deps

- `imapflow` — IMAP client with IDLE support
- `nodemailer` — SMTP sending
- `mailparser` — MIME email parsing

### Complexity: **XL**

---

## P1b: Passive Observation Mode

**Goal:** Silently read all Slack channel messages to learn patterns without triggering agent responses.

### New files

| File                     | LOC  | Description                                                                                                                                                                                |
| ------------------------ | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/daemon/observer.ts` | ~150 | `ObservationPipeline` class. Receives messages in observe mode, feeds through `indexConversationTurn()` (synthetic empty outgoing) + style model extractor. Does NOT trigger agent runtime |

### Modified files

| File                                   | Change                                                                                                                               |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `src/daemon/types.ts`                  | Add optional `mode?: "respond" \| "observe"` to `ChannelAdapter` interface                                                           |
| `src/daemon/gateway.ts`                | In `registerChannelAdapters()`, check adapter mode. If `observe`, route to `ObservationPipeline` instead of `messageQueue.enqueue()` |
| `src/daemon/channels/slack-user.ts`    | Accept `mode` option. In observe mode, listen to ALL channel messages (remove DM/mention filtering)                                  |
| `src/daemon/channels/slack-polling.ts` | Same observe mode support                                                                                                            |

### New config: `config` table entries like `observe.slack-user:TEAM_ID.channels` = `["C123", "C456"]`

### Complexity: **M**

---

## P1c: Cross-Channel Identity Graph

**Goal:** Unified contacts table linking Slack ID ↔ email ↔ phone ↔ Discord, with relationship metadata.

### New files

| File                           | LOC  | Description                                                                                                                    |
| ------------------------------ | ---- | ------------------------------------------------------------------------------------------------------------------------------ | ---- | ------ | ----- | ----- |
| `src/identity/contacts.ts`     | ~200 | Core CRUD: `createContact()`, `getContact()`, `listContacts()`, `searchContacts()`, `resolveContact(platform, platformUserId)` |
| `src/identity/identities.ts`   | ~150 | `linkIdentity(contactId, platform, platformUserId)`, `unlinkIdentity()`, `resolveContact()`                                    |
| `src/identity/auto-linker.ts`  | ~200 | Heuristic auto-linking: same display name (fuzzy), email match, user-confirmed. Runs after ingestion or via cron               |
| `src/identity/relationship.ts` | ~100 | Relationship metadata: role (colleague/friend/family/client), frequency, topics                                                |
| `src/cli/contacts.ts`          | ~150 | CLI: `nomos contacts list                                                                                                      | link | unlink | merge | show` |

### Modified files

| File                        | Change                                                                     |
| --------------------------- | -------------------------------------------------------------------------- |
| `src/cli/program.ts`        | Add `registerContactsCommand(program)`                                     |
| `src/db/schema.sql`         | Add `contacts` and `contact_identities` tables                             |
| `src/ingest/pipeline.ts`    | After storing messages, call `resolveContact()` to populate identity graph |
| `src/memory/style-model.ts` | Use `contact_id` from identity graph for style lookups                     |

### New DB tables

```sql
CREATE TABLE IF NOT EXISTS contacts (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name TEXT NOT NULL,
  role         TEXT,
  relationship JSONB NOT NULL DEFAULT '{}',
  autonomy     TEXT NOT NULL DEFAULT 'draft'
               CHECK (autonomy IN ('auto', 'draft', 'silent')),
  notes        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_contacts_name ON contacts(display_name);

CREATE TABLE IF NOT EXISTS contact_identities (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id        UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  platform          TEXT NOT NULL,
  platform_user_id  TEXT NOT NULL,
  display_name      TEXT,
  email             TEXT,
  metadata          JSONB NOT NULL DEFAULT '{}',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (platform, platform_user_id)
);
CREATE INDEX IF NOT EXISTS idx_ci_contact ON contact_identities(contact_id);
CREATE INDEX IF NOT EXISTS idx_ci_platform ON contact_identities(platform, platform_user_id);
```

### Complexity: **L**

---

## P2a: Universal Draft-and-Approve

**Goal:** Extend draft-and-approve from Slack-only to all channels, with per-contact autonomy levels.

### New files: None — modifications only

### Modified files

| File                              | Change                                                                                                                                                          |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/daemon/draft-manager.ts`     | Before creating a draft, look up contact's `autonomy` from `contacts` table. `auto` → call `sendFn` directly. `silent` → discard. `draft` → create draft as now |
| `src/daemon/gateway.ts`           | For non-Slack adapters (iMessage, Discord, Telegram, WhatsApp, Email), route outgoing through `DraftManager`. Register their send fns                           |
| `src/daemon/channels/imessage.ts` | Register send fn with `DraftManager`                                                                                                                            |
| `src/daemon/channels/discord.ts`  | Register send fn with `DraftManager`                                                                                                                            |
| `src/daemon/channels/telegram.ts` | Register send fn with `DraftManager`                                                                                                                            |
| `src/daemon/channels/whatsapp.ts` | Register send fn with `DraftManager`                                                                                                                            |

### Complexity: **M**

---

## P2b: Proactive Agency

**Goal:** Follow-up tracking, pre-meeting briefs, cross-channel priority triage.

### New files

| File                                  | LOC  | Description                                                                                                                                                    |
| ------------------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/proactive/commitment-tracker.ts` | ~250 | Extract commitments from conversations via `runForkedAgent()` (Haiku). Store in `commitments` table with deadline. Trigger reminders via cron                  |
| `src/proactive/meeting-briefer.ts`    | ~200 | Pre-meeting context: Google Calendar events (via gws MCP), look up attendees in identity graph, retrieve recent conversations, generate brief via forked agent |
| `src/proactive/priority-triage.ts`    | ~200 | Aggregate unread across channels, rank by sender importance (from contacts relationship), recency, urgency. Deliver periodic summary                           |
| `src/proactive/scheduler.ts`          | ~100 | Create cron jobs for above features using existing `CronEngine`                                                                                                |

### Modified files

| File                | Change                  |
| ------------------- | ----------------------- |
| `src/db/schema.sql` | Add `commitments` table |

### New DB table

```sql
CREATE TABLE IF NOT EXISTS commitments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id  UUID REFERENCES contacts(id),
  description TEXT NOT NULL,
  source_msg  TEXT,
  deadline    TIMESTAMPTZ,
  status      TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending', 'completed', 'expired', 'cancelled')),
  reminded    BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_commitments_status ON commitments(status, deadline);
```

### Complexity: **L**

---

## P3: CATE Protocol — Standalone Library + Nomos Integration

**Key decision:** CATE is built as a **standalone npm library** (`@cate-protocol/sdk`), not embedded in Nomos. Nomos becomes the first consumer. This mirrors how MCP (`@modelcontextprotocol/sdk`) and A2A (`@a2aproject/a2a-sdk`) are structured — protocol spec + reference SDK, usable by any project.

**Repo location:** `/Users/meidad/workdir/projectnomos/cate-protocol/`

### P3-init: Repo Scaffold + Documentation

Create the repo with full documentation from day one:

```
cate-protocol/
  README.md                       # Project overview, quick start, motivation
  CONTRIBUTING.md                 # How to contribute, PR process, code style
  LICENSE                         # Apache 2.0 (same as A2A/MCP)
  CLAUDE.md                       # Claude Code instructions for the repo
  .github/
    ISSUE_TEMPLATE/
      bug_report.md
      feature_request.md
    workflows/
      ci.yml                      # pnpm install → typecheck → lint → test
      publish.yml                 # npm publish on tag
  spec/
    PROTOCOL.md                   # Formal protocol specification (from consumer_agent_trust_protocol_md.md, expanded)
    ENVELOPE.md                   # Envelope schema reference with field-by-field docs
    IDENTITY.md                   # DID + VC + Agent Card specification
    ENCRYPTION.md                 # MLS integration specification
    POLICY.md                     # Policy engine rules, intent categories, consent model
    STAMPS.md                     # Micropayment + PoW stamp specification
    SECURITY.md                   # Security model + OWASP mapping (from spec doc)
    MIGRATION.md                  # Migration guide from A2A / MCP into CATE
    REGULATORY.md                 # EU AI Act readiness (from spec doc)
  docs/
    getting-started.md            # Step-by-step: install, create DID, send first message
    concepts/
      overview.md                 # Architecture overview with diagrams
      identity.md                 # DID, VC, Agent Card explained
      envelope.md                 # Envelope lifecycle: create → sign → encrypt → send → verify
      stamps.md                   # When to use micropayment vs PoW stamps
      policy.md                   # Policy engine configuration guide
    guides/
      basic-agent.md              # Build a minimal CATE agent
      mcp-bridge.md               # Wrap MCP tools in CATE envelopes
      a2a-migration.md            # Migrate from A2A to CATE
      custom-transport.md         # Implement a custom transport
    api/                          # Auto-generated from TSDoc (typedoc)
      README.md
  packages/
    sdk/
      ...                         # (as previously specified)
    examples/
      ...
  package.json                    # pnpm workspaces monorepo root
  pnpm-workspace.yaml
  tsconfig.json
  vitest.config.ts
```

### Library Architecture

Following patterns from MCP TypeScript SDK and A2A:

```
cate-protocol/
  packages/
    sdk/                          # @cate-protocol/sdk — core library
      src/
        types/                    # Zod schemas + TypeScript types
          envelope.ts             # CATE_Envelope schema
          did.ts                  # DID Document, VC types
          stamps.ts               # Stamp types (micropayment, PoW)
          policy.ts               # Intent, consent, rate-limit types
        identity/
          did-resolver.ts         # DID resolution (did:key, did:web)
          vc.ts                   # VC issuance + verification
          agent-card.ts           # A2A-compatible Agent Card
          keystore.ts             # Abstract keystore interface
        encryption/
          mls-group.ts            # MLS group management
          mls-keys.ts             # KeyPackage generation
        policy/
          engine.ts               # Policy evaluator
          intent.ts               # Intent classifier
          consent.ts              # Consent/scope management
          rate-limiter.ts         # Token bucket rate limiter
        stamps/
          micropayment.ts         # Micropayment stamp
          pow.ts                  # Proof-of-work stamp
          verifier.ts             # Unified stamp verification
        transport/
          base.ts                 # Abstract transport interface
          http.ts                 # HTTP transport (REST + SSE)
          stdio.ts                # Stdio transport (for MCP-style usage)
        adapters/
          a2a.ts                  # A2A ↔ CATE bridge
          mcp.ts                  # MCP ↔ CATE bridge
        client.ts                 # CATEClient — connect to a CATE peer
        server.ts                 # CATEServer — serve CATE endpoints
        index.ts                  # Main exports
      package.json
      tsconfig.json
      vitest.config.ts
    examples/                     # Reference implementations
      basic-agent/                # Minimal agent with CATE identity
      stamped-messaging/          # Agent-to-agent with stamps
      mcp-bridge/                 # CATE envelope wrapping MCP tools
  spec/
    PROTOCOL.md                   # Formal protocol specification
    ENVELOPE.md                   # Envelope schema reference
    SECURITY.md                   # Security model + threat analysis
  README.md
  package.json                    # Monorepo root (pnpm workspaces)
```

### Developer API Surface (what third-party devs see)

```typescript
import { CATEServer, CATEClient } from "@cate-protocol/sdk";
import { createDID, issueVC } from "@cate-protocol/sdk/identity";
import { createPoWStamp } from "@cate-protocol/sdk/stamps";
import type { CATEEnvelope } from "@cate-protocol/sdk/types";

// Server — receive and validate CATE messages
const server = new CATEServer({
  identity: { did: myDID, keystore: myKeystore },
  policy: { rules: [...], rateLimits: {...} },
  onMessage: async (envelope) => { /* handle */ },
});
await server.listen({ transport: new HttpTransport({ port: 8800 }) });

// Client — send CATE messages to another agent
const client = new CATEClient({
  identity: { did: myDID, keystore: myKeystore },
});
await client.connect("did:web:other-agent.example.com");
await client.send({
  intent: "personal",
  content: "Hello from my agent",
  stamp: createPoWStamp({ difficulty: 20 }),
});
```

### P3 Sub-phases (within the library)

**P3e: Types + Envelope** (start here, M complexity)

- `types/envelope.ts` — Zod schema for CATE_Envelope matching spec
- `types/did.ts`, `types/stamps.ts`, `types/policy.ts` — all protocol types
- `adapters/a2a.ts`, `adapters/mcp.ts` — bridge types

**P3d: Stamps** (M complexity)

- `stamps/micropayment.ts` — receipt creation/verification
- `stamps/pow.ts` — SHA-256 PoW with configurable difficulty
- `stamps/verifier.ts` — unified verification

**P3a: Identity Layer** (XL complexity)

- `identity/did-resolver.ts` — `did:key` + `did:web` resolution
- `identity/vc.ts` — "acts-for" VC issuance (JWT format)
- `identity/agent-card.ts` — A2A-compatible signed Agent Card
- `identity/keystore.ts` — abstract interface (consumers provide storage)

**P3c: Policy Engine** (L complexity)

- `policy/engine.ts` — evaluate envelope against rules
- `policy/intent.ts` — classifier
- `policy/consent.ts` — OAuth scope mapping
- `policy/rate-limiter.ts` — token bucket per DID

**P3b: Encryption (MLS)** (XL complexity)

- `encryption/mls-group.ts` — group management, epoch, ratchet
- `encryption/mls-keys.ts` — KeyPackage, HPKE keys
- Transport integration for encrypted channels

**P3f: Transport + Server/Client** (L complexity)

- `transport/base.ts` — abstract transport interface
- `transport/http.ts` — HTTP reference transport
- `client.ts` — `CATEClient` high-level API
- `server.ts` — `CATEServer` high-level API

### Nomos Integration (in the Nomos repo)

Once the library exists, Nomos consumes it:

| File                          | LOC  | Description                                                                                                            |
| ----------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------- |
| `src/cate/integration.ts`     | ~200 | Nomos-specific CATE setup: creates DID from encrypted keystore, issues "acts-for" VC, configures policy from DB config |
| `src/cate/nomos-keystore.ts`  | ~80  | Implements `@cate-protocol/sdk` Keystore interface using Nomos's `src/db/encryption.ts`                                |
| `src/cate/nomos-transport.ts` | ~100 | CATE transport adapter that hooks into Nomos's gRPC/WebSocket servers                                                  |

### New deps (library)

- `did-jwt` + `did-jwt-vc` — JWT-based DIDs/VCs
- `@noble/ed25519` — Ed25519 operations
- `@noble/hashes` — SHA-256 for PoW stamps
- `zod` — schema validation
- MLS implementation (TBD — JS ecosystem immature)

### New deps (Nomos integration)

- `@cate-protocol/sdk` — the library itself

### Total library complexity: **XL** (but distributable across contributors since it's a separate repo)

---

## Implementation Order (Dependency Graph)

```
P0a: Ingestion Pipeline              ← START HERE (no deps)
  ├──→ P0b: Style Model              (needs ingested sent messages)
  ├──→ P0c: Knowledge Wiki           (needs ingested data to compile)
  └──→ P1c: Identity Graph           (needs ingested contacts)
         ├──→ P1b: Passive Observation (needs contact resolution)
         ├──→ P2a: Universal Draft     (needs autonomy from contacts)
         │      └──→ P2b: Proactive Agency (needs drafts + contacts + calendar)
         └──→ P1a: Email Channel       (can parallel with P1b)

CATE Library (separate repo, can start in parallel with P0-P2):
P3e: Types + Envelope                ← START P3 HERE
  ├──→ P3d: Stamps                    (needs types)
  ├──→ P3a: Identity Layer            (needs types)
  │      └──→ P3c: Policy Engine      (needs identity + stamps)
  │             └──→ P3b: Encryption  (needs identity + policy)
  └──→ P3f: Transport + Server/Client (needs all above)
         └──→ Nomos Integration       (needs library published)
```

### Recommended sequence

**Nomos repo (digital clone features):**

1. **Sprint 1–2:** P0a (Ingestion Pipeline + Settings UI + Auto-Sync + Onboarding)
2. **Sprint 3:** P0b (Style Model) + P1c (Identity Graph) — in parallel
3. **Sprint 4:** P0c (Knowledge Wiki) + P1b (Passive Observation) — in parallel
4. **Sprint 5:** P1a (Email Channel)
5. **Sprint 6:** P2a (Universal Draft Mode)
6. **Sprint 7–8:** P2b (Proactive Agency)

**CATE library repo (can run in parallel with above):** 7. **Sprint 3–4:** P3e (Types + Envelope) + P3d (Stamps) 8. **Sprint 5–6:** P3a (Identity Layer) 9. **Sprint 7–8:** P3c (Policy Engine) 10. **Sprint 9–10:** P3b (Encryption/MLS) + P3f (Transport + Server/Client) 11. **Sprint 11:** Nomos integration (consume `@cate-protocol/sdk`)

---

## New CLI Commands

| Command                                                                                       | Phase |
| --------------------------------------------------------------------------------------------- | ----- |
| `nomos ingest <slack\|gmail\|imessage\|whatsapp> [--since DATE] [--contact NAME] [--dry-run]` | P0a   |
| `nomos ingest status`                                                                         | P0a   |
| `nomos contacts list [--platform]`                                                            | P1c   |
| `nomos contacts link <contact-id> <platform> <user-id>`                                       | P1c   |
| `nomos contacts unlink <identity-id>`                                                         | P1c   |
| `nomos contacts merge <id1> <id2>`                                                            | P1c   |
| `nomos contacts show <contact-id>`                                                            | P1c   |

---

## All New Dependencies

| Package          | Phase | Purpose                |
| ---------------- | ----- | ---------------------- |
| `imapflow`       | P1a   | IMAP client with IDLE  |
| `nodemailer`     | P1a   | SMTP sending           |
| `mailparser`     | P1a   | MIME email parsing     |
| `did-jwt`        | P3a   | JWT-based DIDs         |
| `did-jwt-vc`     | P3a   | Verifiable Credentials |
| `@noble/ed25519` | P3a   | Ed25519 key operations |

---

## Test Strategy

Unit tests (colocated `*.test.ts`, vitest):

- `src/ingest/dedup.test.ts` — hash deduplication
- `src/ingest/sources/whatsapp.test.ts` — export parser with fixture
- `src/memory/style-model.test.ts` — profile merging (global + per-contact)
- `src/memory/style-prompt.test.ts` — prompt generation from profiles
- `src/identity/auto-linker.test.ts` — fuzzy name matching
- `src/cate/envelope.test.ts` — Zod schema validation
- `src/cate/stamps/pow.test.ts` — PoW generation/verification
- `src/cate/policy/rate-limiter.test.ts` — token bucket behavior

Integration tests:

- Ingestion e2e: source → dedup → chunk → embed → store
- Contact resolution across platforms
- Draft flow with autonomy levels

Mock patterns: Mock `runForkedAgent()` for style tests. Mock `@slack/web-api` for Slack ingestion. In-memory SQLite for iMessage source tests.

---

## Cross-Cutting Concerns (applies across all phases)

### 1. API Rate Limiting for Bulk Ingestion

Slack and Gmail have aggressive rate limits. Ingestion sources must handle this gracefully:

| Platform                      | Rate Limit              | Strategy                                                                                                                |
| ----------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Slack `conversations.history` | Tier 3: ~50 req/min     | Exponential backoff, 1.2s delay between pages. Use `retry-after` header. Existing `withRetry()` from `src/sdk/retry.ts` |
| Gmail API                     | 250 quota units/sec     | Batch API calls, respect `429` responses. Use `gmail.users.messages.list` (1 unit) then `get` (5 units)                 |
| iMessage chat.db              | Local SQLite, no limits | Batch 1000 rows per query to avoid memory spikes                                                                        |
| WhatsApp export               | Local file, no limits   | Stream-parse line by line                                                                                               |

Add to `src/ingest/pipeline.ts`: a configurable `rateLimiter` option per source that throttles calls. Default delays baked into each source implementation.

### 2. Cost Guardrails for LLM Operations

The knowledge wiki, style analysis, and delta extraction all use LLM calls. Without guardrails, costs can spiral.

| Operation                       | Model  | Estimated Cost per Run | Guardrail                           |
| ------------------------------- | ------ | ---------------------- | ----------------------------------- |
| Style analysis (per contact)    | Haiku  | ~$0.02                 | Max 50 contacts per batch           |
| Wiki compilation (per article)  | Sonnet | ~$0.10                 | Max 20 articles per compilation run |
| Knowledge extraction (per turn) | Haiku  | ~$0.01                 | Already fire-and-forget, low cost   |
| Wiki health check               | Haiku  | ~$0.05                 | Run at most 1x/day                  |

Add config keys:

- `app.wikiMaxArticlesPerRun` (default: 20)
- `app.styleMaxContactsPerBatch` (default: 50)
- `app.monthlyLlmBudgetUsd` (default: null = unlimited) — global soft cap, logged warnings when approached

Track all background LLM costs in the existing `CostTracker` singleton. New Settings UI widget on `/admin/costs` showing background vs interactive cost split.

### 3. Clone Validation ("Does it sound like me?")

Before going live, the user needs confidence the clone is accurate. Add a validation flow:

| Feature                    | Phase | Description                                                                                                                                                              |
| -------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Style preview**          | P0b   | After style analysis, show 3 sample responses in the user's voice. "Here's how I'd respond to: 'Can you review this PR?'" Side-by-side: user's actual style vs generated |
| **Draft review dashboard** | P2a   | Settings UI page showing recent drafts: approved vs rejected ratio, common rejection reasons. Feedback loop into style model                                             |
| **Confidence score**       | P0b   | Per-contact style confidence based on sample count. Below threshold (< 20 samples) → warn that style may be unreliable                                                   |
| **Test conversation**      | P2a   | CLI: `nomos clone test --contact "Sarah"` — simulates incoming messages and shows what the clone would draft, without sending                                            |

### 4. Contact Privacy & Data Rights

The clone learns about other people from the user's communications. Considerations:

- **No PII in wiki article titles** — use contact IDs, resolve names at read time
- **Per-contact data deletion** — `nomos contacts forget <id>` removes all ingested messages, wiki articles, style profiles, and memory chunks for that contact
- **Observation consent flag** — contacts table gets `data_consent` column (default: `"inferred"`, can be `"explicit"` or `"withdrawn"`)
- **No outbound sharing of learned data** — wiki/style data never leaves the system in agent responses to third parties

Add to `contacts` table:

```sql
data_consent TEXT NOT NULL DEFAULT 'inferred'
  CHECK (data_consent IN ('inferred', 'explicit', 'withdrawn'))
```

### 5. Monitoring & Observability

| Signal                | Where                                | How                                                                    |
| --------------------- | ------------------------------------ | ---------------------------------------------------------------------- |
| Ingestion health      | `ingest_jobs` table                  | Status, error count, last successful delta. Settings UI dashboard      |
| Wiki freshness        | `wiki_articles.compiled_at`          | Stale article detection (>24h old with new data)                       |
| Delta sync failures   | Cron run history (`cron_runs` table) | Alert on 3 consecutive failures (existing `disableOnErrors()` pattern) |
| Style model coverage  | `style_profiles.sample_count`        | Per-contact confidence. Warn when below threshold                      |
| LLM cost tracking     | `CostTracker` singleton              | Background vs interactive cost breakdown                               |
| Disk ↔ DB sync health | Wiki sync on startup                 | Log discrepancies, auto-heal from DB                                   |

All surfaced in the Settings UI at `/admin/dashboard` (existing page, add new widgets).

### 6. Data Export & Portability

- `nomos export wiki` — dumps `~/.nomos/wiki/` as a zip (already on disk) or from DB
- `nomos export contacts` — CSV export of contacts + identities
- `nomos export memory` — export memory chunks as JSONL
- These are simple CLI commands (one file: `src/cli/export.ts`, ~150 LOC)
- Phase: add alongside P1c (when contacts exist)

---

## Documentation (per-phase, not deferred)

Every phase includes documentation as a deliverable, not an afterthought. Documentation is written as part of the sprint, not in a separate "docs sprint."

### Nomos Documentation Updates

| Phase                 | Documentation Deliverables                                                                                                                                                                               |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0a: Ingestion        | Update `CLAUDE.md` Architecture section with ingestion pipeline. New `docs/ingestion.md` — supported platforms, filtering strategy, CLI usage, delta sync config. Update `TOOLS.md` with ingest commands |
| P0b: Style Model      | New `docs/style-model.md` — how style profiles work, per-contact vs global, how to retrain. Update `CLAUDE.md` with style-model architecture                                                             |
| P0c: Knowledge Wiki   | New `docs/knowledge-wiki.md` — wiki structure, compilation pipeline, how agent uses wiki vs RAG, configuration. Reference Karpathy approach                                                              |
| P1a: Email            | New `docs/channels/email.md` — IMAP/SMTP setup, Gmail OAuth, draft approval flow. Add to Settings UI help text                                                                                           |
| P1b: Observation      | New `docs/observation-mode.md` — what it does, privacy implications, per-channel config                                                                                                                  |
| P1c: Identity Graph   | New `docs/contacts.md` — unified contacts, auto-linking, relationship metadata, autonomy levels, CLI usage                                                                                               |
| P2a: Universal Draft  | Update `docs/channels/` per-channel docs with draft mode info. New `docs/autonomy-levels.md`                                                                                                             |
| P2b: Proactive Agency | New `docs/proactive.md` — commitments, meeting briefs, triage. Configuration guide                                                                                                                       |

### Documentation Standards

- All new modules get TSDoc comments on exported functions/interfaces
- Each `docs/*.md` file follows structure: **Overview** → **Configuration** → **How It Works** → **CLI Usage** → **Settings UI** → **Troubleshooting**
- `CLAUDE.md` stays the authoritative architecture reference — updated every sprint with new modules, config keys, DB tables
- Settings UI pages include inline help text and links to docs
- README.md updated with new feature highlights per release

### CATE Library Documentation

Covered in P3-init above — `spec/` for protocol spec, `docs/` for developer guides, auto-generated API docs via typedoc. Every module in the SDK gets TSDoc comments. Examples serve as living documentation.

---

## Verification

After each phase:

1. Run `pnpm check` (format + typecheck + lint)
2. Run `pnpm test` (all unit tests pass)
3. Phase-specific verification:
   - **P0a:** `pnpm dev -- ingest imessage --since 2024-01-01 --dry-run` shows message count
   - **P0b:** Query `style_profiles` table, verify global profile populated
   - **P1c:** `pnpm dev -- contacts list` shows auto-linked contacts from ingested data
   - **P1a:** Configure test IMAP, verify email appears in daemon logs
   - **P2a:** Send test iMessage, verify draft created (not auto-sent)
   - **P3e:** Unit test validates envelope schema against CATE spec

---

## Summary

### Nomos repo

| Phase                           | New Files | Modified Files | New Tables | Complexity |
| ------------------------------- | --------- | -------------- | ---------- | ---------- |
| P0a: Ingestion + UI + Auto-Sync | 13        | 5              | 1          | XL         |
| P0b: Style Model + UI           | 4         | 4              | 1          | L          |
| P0c: Knowledge Wiki             | 5         | 4              | 1          | L          |
| P1a: Email Channel + UI         | 4         | 1              | 0          | XL         |
| P1b: Passive Observation        | 1         | 5              | 0          | M          |
| P1c: Identity Graph + UI        | 7         | 4              | 2          | L          |
| P2a: Universal Draft            | 0         | 6              | 0          | M          |
| P2b: Proactive Agency + UI      | 5         | 1              | 1          | L          |
| Nomos CATE Integration          | 3         | 2              | 0          | M          |
| Cross-cutting: Export CLI       | 1         | 0              | 0          | S          |

| SQLC for type safe or same
| **Nomos Total** | **44** | **33** | **6** | |

### CATE library repo (`/Users/meidad/workdir/projectnomos/cate-protocol/`)

| Phase                          | Files   | Complexity |
| ------------------------------ | ------- | ---------- |
| P3-init: Repo scaffold + docs  | ~15     | M          |
| P3e: Types + Envelope          | ~8      | M          |
| P3d: Stamps                    | 3       | M          |
| P3a: Identity Layer            | 4       | XL         |
| P3c: Policy Engine             | 4       | L          |
| P3b: Encryption (MLS)          | 3       | XL         |
| P3f: Transport + Server/Client | 5       | L          |
| Examples                       | 3 dirs  | M          |
| **Library Total**              | **~45** |            |

### Key Design Decisions

1. **Settings UI for everything** — every feature gets an admin page + API route in the Next.js settings app
2. **Onboarding auto-ingestion** — new "Data Sync" step in setup wizard; channel connect triggers background ingest
3. **Continuous delta sync** — cron jobs per platform, cursor-based (Slack cursor, Gmail historyId, iMessage ROWID)
4. **pgvector + compiled wiki** — pgvector for raw search (HNSW index), LLM-compiled markdown wiki for synthesized knowledge (Karpathy approach). Not pure RAG.
5. **Sent-only filtering** — Slack: sent messages only; Gmail: sent folder only; iMessage/WhatsApp: both directions but style trains on sent only
6. **CATE as standalone library** — `@cate-protocol/sdk` in its own repo, following MCP/A2A patterns (types subpath exports, abstract transport, client/server symmetry). Nomos is the first consumer.
7. **Knowledge graph via structured data, not graph DB** — contacts table + wiki backlinks provide graph semantics without Neo4j complexity. Can add `pg_graphql` later if needed.
