-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Configuration key-value store
CREATE TABLE IF NOT EXISTS config (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Sessions
CREATE TABLE IF NOT EXISTS sessions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_key TEXT UNIQUE NOT NULL,
  agent_id    TEXT NOT NULL DEFAULT 'default',
  model       TEXT,
  status      TEXT NOT NULL DEFAULT 'active',
  metadata    JSONB NOT NULL DEFAULT '{}',
  token_usage JSONB NOT NULL DEFAULT '{"input": 0, "output": 0}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);

-- Transcript messages
CREATE TABLE IF NOT EXISTS transcript_messages (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id  UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role        TEXT NOT NULL,
  content     JSONB NOT NULL,
  usage       JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_transcript_session ON transcript_messages(session_id, id);

-- Memory chunks with vector embeddings
CREATE TABLE IF NOT EXISTS memory_chunks (
  id              TEXT PRIMARY KEY,
  source          TEXT NOT NULL,
  path            TEXT,
  text            TEXT NOT NULL,
  embedding       vector(768),
  start_line      INT,
  end_line        INT,
  hash            TEXT,
  model           TEXT,
  access_count    INT NOT NULL DEFAULT 0,
  last_accessed_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_memory_source ON memory_chunks(source);
CREATE INDEX IF NOT EXISTS idx_memory_path ON memory_chunks(path);

-- Cron job definitions
CREATE TABLE IF NOT EXISTS cron_jobs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  schedule        TEXT NOT NULL,
  schedule_type   TEXT NOT NULL CHECK (schedule_type IN ('at', 'every', 'cron')),
  session_target  TEXT NOT NULL DEFAULT 'isolated' CHECK (session_target IN ('main', 'isolated')),
  delivery_mode   TEXT NOT NULL DEFAULT 'none' CHECK (delivery_mode IN ('none', 'announce')),
  prompt          TEXT NOT NULL,
  platform        TEXT,
  channel_id      TEXT,
  enabled         BOOLEAN NOT NULL DEFAULT true,
  error_count     INT NOT NULL DEFAULT 0,
  last_run        TIMESTAMPTZ,
  last_error      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cron_name ON cron_jobs(name);
CREATE INDEX IF NOT EXISTS idx_cron_enabled ON cron_jobs(enabled);
CREATE INDEX IF NOT EXISTS idx_cron_platform ON cron_jobs(platform);

-- Cron job execution history
CREATE TABLE IF NOT EXISTS cron_runs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id       UUID NOT NULL REFERENCES cron_jobs(id) ON DELETE CASCADE,
  job_name     TEXT NOT NULL,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at  TIMESTAMPTZ,
  success      BOOLEAN NOT NULL,
  error        TEXT,
  duration_ms  INT,
  session_key  TEXT
);

CREATE INDEX IF NOT EXISTS idx_cron_runs_job ON cron_runs(job_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_cron_runs_started ON cron_runs(started_at DESC);

-- Full-text search index on memory chunks
CREATE INDEX IF NOT EXISTS idx_memory_fts ON memory_chunks
  USING gin(to_tsvector('english', text));

-- Vector similarity index (created after data is inserted for better performance)
-- Run manually after initial data load:
-- CREATE INDEX IF NOT EXISTS idx_memory_vector ON memory_chunks
--   USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- Pairing requests for secure bot access
CREATE TABLE IF NOT EXISTS pairing_requests (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel     TEXT NOT NULL,
  platform    TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  code        TEXT UNIQUE NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  approved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_pairing_code ON pairing_requests(code);
CREATE INDEX IF NOT EXISTS idx_pairing_status ON pairing_requests(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_pairing_platform ON pairing_requests(platform, user_id);

-- Channel allowlists for bot access control
CREATE TABLE IF NOT EXISTS channel_allowlists (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform    TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  added_by    TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (platform, user_id)
);

CREATE INDEX IF NOT EXISTS idx_allowlist_platform ON channel_allowlists(platform);

-- Draft messages for Slack User Mode (approve-before-send)
CREATE TABLE IF NOT EXISTS draft_messages (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform     TEXT NOT NULL,
  channel_id   TEXT NOT NULL,
  thread_id    TEXT,
  user_id      TEXT NOT NULL,
  in_reply_to  TEXT NOT NULL,
  content      TEXT NOT NULL,
  context      JSONB NOT NULL DEFAULT '{}',
  status       TEXT NOT NULL DEFAULT 'pending',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_at  TIMESTAMPTZ,
  sent_at      TIMESTAMPTZ,
  expires_at   TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_draft_status ON draft_messages(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_draft_user ON draft_messages(user_id, status);

-- Slack User Mode workspace tokens (multi-workspace)
CREATE TABLE IF NOT EXISTS slack_user_tokens (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id      TEXT UNIQUE NOT NULL,
  team_name    TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  access_token TEXT NOT NULL,
  scopes       TEXT NOT NULL DEFAULT '',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_slack_user_team ON slack_user_tokens(team_id);

-- Unified integrations store (replaces per-integration env vars)
CREATE TABLE IF NOT EXISTS integrations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT UNIQUE NOT NULL,
  enabled     BOOLEAN NOT NULL DEFAULT true,
  config      JSONB NOT NULL DEFAULT '{}',
  secrets     TEXT NOT NULL DEFAULT '',
  metadata    JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_integrations_name ON integrations(name);
CREATE INDEX IF NOT EXISTS idx_integrations_enabled ON integrations(enabled);

-- Migration: add temporal decay columns to memory_chunks (idempotent)
DO $$ BEGIN
  ALTER TABLE memory_chunks ADD COLUMN IF NOT EXISTS access_count INT NOT NULL DEFAULT 0;
  ALTER TABLE memory_chunks ADD COLUMN IF NOT EXISTS last_accessed_at TIMESTAMPTZ;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- Agent permissions (persistent "always allow" rules)
CREATE TABLE IF NOT EXISTS agent_permissions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_type   TEXT NOT NULL,
  action          TEXT NOT NULL,
  pattern         TEXT NOT NULL,
  granted_by      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (resource_type, action, pattern)
);

CREATE INDEX IF NOT EXISTS idx_permissions_lookup
  ON agent_permissions(resource_type, action);

-- Migration: add metadata JSONB column to memory_chunks for categorization (idempotent)
DO $$ BEGIN
  ALTER TABLE memory_chunks ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}';
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_memory_metadata ON memory_chunks USING gin(metadata);

-- User model: accumulated preferences and facts learned from conversations
CREATE TABLE IF NOT EXISTS user_model (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     TEXT NOT NULL DEFAULT 'local',  -- owner; per-person accumulated model
  category    TEXT NOT NULL,
  key         TEXT NOT NULL,
  value       JSONB NOT NULL,
  source_ids  TEXT[] NOT NULL DEFAULT '{}',
  confidence  FLOAT NOT NULL DEFAULT 0.5,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, category, key)
);

-- Per-user hardening: the user model used to be global (UNIQUE(category,key)).
-- Swap to a per-owner key so two members of one DB keep separate models. The
-- ADD CONSTRAINT references user_id, so on a legacy table (CREATE was a no-op)
-- the column must be added first, here, not in the later Phase-4b block.
-- All idempotent.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'user_model' AND column_name = 'user_id'
  ) THEN
    ALTER TABLE user_model ADD COLUMN user_id TEXT NOT NULL DEFAULT 'local';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_model_category_key_key') THEN
    ALTER TABLE user_model DROP CONSTRAINT user_model_category_key_key;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_model_user_id_category_key_key') THEN
    ALTER TABLE user_model ADD CONSTRAINT user_model_user_id_category_key_key UNIQUE (user_id, category, key);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_user_model_category ON user_model(category);

-- Migration: add cost tracking columns to sessions (idempotent)
DO $$ BEGIN
  ALTER TABLE sessions ADD COLUMN IF NOT EXISTS total_cost_usd NUMERIC NOT NULL DEFAULT 0;
  ALTER TABLE sessions ADD COLUMN IF NOT EXISTS input_tokens BIGINT NOT NULL DEFAULT 0;
  ALTER TABLE sessions ADD COLUMN IF NOT EXISTS output_tokens BIGINT NOT NULL DEFAULT 0;
  ALTER TABLE sessions ADD COLUMN IF NOT EXISTS turn_count INT NOT NULL DEFAULT 0;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- Migration: drop unused memory_files table (idempotent)
DROP TABLE IF EXISTS memory_files;

-- Seed config defaults (idempotent — never overwrites user values)
INSERT INTO config (key, value) VALUES
  ('app.model',              '"claude-sonnet-4-6"'),
  ('app.permissionMode',     '"acceptEdits"'),
  ('app.teamMode',           '"true"'),
  ('app.maxTeamWorkers',     '4'),
  ('app.workerBudgetUsd',    '2'),
  ('app.smartRouting',       '"false"'),
  ('app.adaptiveMemory',     '"true"'),
  ('app.extractionModel',    '"claude-haiku-4-5"'),
  ('app.sessionScope',       '"channel"'),
  ('app.toolApprovalPolicy', '"block_critical"'),
  ('app.defaultDmPolicy',    '"open"'),
  ('app.heartbeatIntervalMs','"1800000"')
ON CONFLICT (key) DO NOTHING;

-- Ingestion job tracking
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
CREATE INDEX IF NOT EXISTS idx_ingest_platform ON ingest_jobs(platform, source_type);

-- Add run_type column for full vs delta tracking (multi-row per platform)
DO $$ BEGIN
  ALTER TABLE ingest_jobs ADD COLUMN run_type TEXT NOT NULL DEFAULT 'full';
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE ingest_jobs ADD CONSTRAINT ingest_jobs_run_type_check
    CHECK (run_type IN ('full', 'delta'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Drop the single-row-per-platform UNIQUE constraint to allow multiple run rows
DO $$ BEGIN
  ALTER TABLE ingest_jobs DROP CONSTRAINT IF EXISTS ingest_jobs_platform_source_type_contact_key;
EXCEPTION WHEN undefined_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_ingest_platform_runtype
  ON ingest_jobs(platform, source_type, run_type, started_at DESC);

-- Upgrade vector index from IVFFlat to HNSW (better recall, no tuning needed)
DROP INDEX IF EXISTS idx_memory_vector;
CREATE INDEX IF NOT EXISTS idx_memory_vector_hnsw ON memory_chunks
  USING hnsw (embedding vector_cosine_ops);

-- Add ingest delta interval config
INSERT INTO config (key, value) VALUES
  ('app.ingestDeltaInterval', '"6h"')
ON CONFLICT (key) DO NOTHING;

-- Style profiles for communication voice modeling
CREATE TABLE IF NOT EXISTS style_profiles (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      TEXT NOT NULL DEFAULT 'local',  -- owner; each person's voice is private
  contact_id   UUID,
  scope        TEXT NOT NULL DEFAULT 'global',  -- 'global' or 'contact:<name>'
  profile      JSONB NOT NULL DEFAULT '{}',
  sample_count INT NOT NULL DEFAULT 0,
  last_updated TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, scope)
);

-- Per-user hardening: style_profiles used to be global with UNIQUE(contact_id,
-- scope) and no user_id. On an existing DB the CREATE above is a no-op, so add
-- the column then swap the unique key for a per-owner one. contact_id is always
-- NULL in practice (the contact lives in scope as 'contact:<name>'), so the
-- effective key is (user_id, scope). Both idempotent.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'style_profiles' AND column_name = 'user_id'
  ) THEN
    ALTER TABLE style_profiles ADD COLUMN user_id TEXT NOT NULL DEFAULT 'local';
  END IF;
END $$;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'style_profiles_contact_id_scope_key') THEN
    ALTER TABLE style_profiles DROP CONSTRAINT style_profiles_contact_id_scope_key;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'style_profiles_user_id_scope_key') THEN
    ALTER TABLE style_profiles ADD CONSTRAINT style_profiles_user_id_scope_key UNIQUE (user_id, scope);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_style_contact ON style_profiles(contact_id);
CREATE INDEX IF NOT EXISTS idx_style_user ON style_profiles(user_id);

-- Knowledge wiki articles (DB-primary, disk as cache)
CREATE TABLE IF NOT EXISTS wiki_articles (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       TEXT NOT NULL DEFAULT 'local',  -- owner; the compiled wiki is per-person
  path          TEXT NOT NULL,
  title         TEXT NOT NULL,
  content       TEXT NOT NULL,
  category      TEXT NOT NULL,
  backlinks     TEXT[] NOT NULL DEFAULT '{}',
  word_count    INT NOT NULL DEFAULT 0,
  compile_model TEXT,
  compiled_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, path)
);

-- Per-user hardening: wiki_articles used to be global with UNIQUE(path) and no
-- user_id. On an existing DB the CREATE TABLE above is a no-op, so add the column
-- first, then swap the path-unique for a per-owner one. Both idempotent.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'wiki_articles' AND column_name = 'user_id'
  ) THEN
    ALTER TABLE wiki_articles ADD COLUMN user_id TEXT NOT NULL DEFAULT 'local';
  END IF;
END $$;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wiki_articles_path_key') THEN
    ALTER TABLE wiki_articles DROP CONSTRAINT wiki_articles_path_key;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wiki_articles_user_id_path_key') THEN
    ALTER TABLE wiki_articles ADD CONSTRAINT wiki_articles_user_id_path_key UNIQUE (user_id, path);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_wiki_category ON wiki_articles(category);
CREATE INDEX IF NOT EXISTS idx_wiki_path ON wiki_articles(user_id, path);
CREATE INDEX IF NOT EXISTS idx_wiki_user ON wiki_articles(user_id);
CREATE INDEX IF NOT EXISTS idx_wiki_fts ON wiki_articles
  USING gin(to_tsvector('english', content));

-- Agent long-term memory: the vault. Per-user, agent- and human-authored markdown
-- notes that are the SOURCE OF TRUTH for what the clone knows. Distinct from
-- wiki_articles, which holds the DERIVED/compiled wiki (contacts, topic summaries)
-- projected out of this vault + other sources. The agent reads/writes the vault
-- in-loop via the memory_* tools; the user edits it directly.
CREATE TABLE IF NOT EXISTS vault_notes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     TEXT NOT NULL DEFAULT 'local',  -- per-person scoping (zero-trust on top of db-per-user)
  path        TEXT NOT NULL,
  title       TEXT NOT NULL,
  content     TEXT NOT NULL,
  backlinks   TEXT[] NOT NULL DEFAULT '{}',
  word_count  INT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, path)
);
CREATE INDEX IF NOT EXISTS idx_vault_user ON vault_notes(user_id);
CREATE INDEX IF NOT EXISTS idx_vault_path ON vault_notes(user_id, path);
CREATE INDEX IF NOT EXISTS idx_vault_fts ON vault_notes
  USING gin(to_tsvector('english', content));

-- One-time data migration: the vault used to live in wiki_articles under
-- category 'memory'. Move those rows into vault_notes. Idempotent: ON CONFLICT
-- skips already-migrated rows and the DELETE then clears the source, so on every
-- subsequent migrate this is a no-op (no 'memory' rows remain). Stamps user_id
-- 'local' because wiki_articles has no user_id column; live writes carry the
-- real id going forward.
INSERT INTO vault_notes (user_id, path, title, content, backlinks, word_count, created_at, updated_at)
SELECT 'local', path, title, content, backlinks, word_count, created_at, updated_at
FROM wiki_articles WHERE category = 'memory'
ON CONFLICT (user_id, path) DO NOTHING;
DELETE FROM wiki_articles WHERE category = 'memory';

-- One-time heal: the OAuth deposit handler used to write hosted Google accounts as a
-- malformed 'google:USERID' integrations row (no email suffix, no account_email),
-- which the Google MCP read path (prefix 'google:USERID:') can't see -- so it never
-- produced a calendar tool AND showed as a phantom duplicate in Settings alongside the
-- real account. The deposit now writes the canonical 'google:USERID:EMAIL' row, so
-- drop any malformed ones. Idempotent + self-healing: matches only google rows lacking
-- the email suffix, so canonical rows (two colons) are never touched.
DELETE FROM integrations WHERE name LIKE 'google:%' AND name NOT LIKE 'google:%:%';

-- Wiki config defaults (consumed by the knowledge compiler's config resolver).
INSERT INTO config (key, value) VALUES
  ('app.wikiEnabled',           '"true"'),
  ('app.wikiCompileInterval',   '"1h"'),
  ('app.wikiCompileModel',      '"claude-sonnet-4-6"'),
  ('app.wikiMaxArticlesPerRun', '20')
ON CONFLICT (key) DO NOTHING;

-- Unified contacts (cross-platform identity graph)
CREATE TABLE IF NOT EXISTS contacts (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      TEXT NOT NULL DEFAULT 'local',  -- owner; per-person contact graph
  display_name TEXT NOT NULL,
  role         TEXT,
  relationship JSONB NOT NULL DEFAULT '{}',
  autonomy     TEXT NOT NULL DEFAULT 'draft'
               CHECK (autonomy IN ('auto', 'draft', 'silent')),
  data_consent TEXT NOT NULL DEFAULT 'inferred'
               CHECK (data_consent IN ('inferred', 'explicit', 'withdrawn')),
  notes        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_contacts_name ON contacts(display_name);

-- Platform identities linked to contacts
CREATE TABLE IF NOT EXISTS contact_identities (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           TEXT NOT NULL DEFAULT 'local',  -- owner; same platform person can belong to two members
  contact_id        UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  platform          TEXT NOT NULL,
  platform_user_id  TEXT NOT NULL,
  display_name      TEXT,
  email             TEXT,
  metadata          JSONB NOT NULL DEFAULT '{}',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, platform, platform_user_id)
);

CREATE INDEX IF NOT EXISTS idx_ci_contact ON contact_identities(contact_id);
CREATE INDEX IF NOT EXISTS idx_ci_platform ON contact_identities(platform, platform_user_id);

-- Per-user hardening: contacts/contact_identities used to be global. Swap the
-- old global UNIQUE(platform, platform_user_id) for a per-owner one so two
-- members of one DB can each have an identity for the same platform person. The
-- ADD CONSTRAINT references user_id, so on a legacy table the column must be
-- added first, here, not in the later Phase-4b block. All idempotent.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'contact_identities' AND column_name = 'user_id'
  ) THEN
    ALTER TABLE contact_identities ADD COLUMN user_id TEXT NOT NULL DEFAULT 'local';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contact_identities_platform_platform_user_id_key') THEN
    ALTER TABLE contact_identities DROP CONSTRAINT contact_identities_platform_platform_user_id_key;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contact_identities_user_id_platform_platform_user_id_key') THEN
    ALTER TABLE contact_identities ADD CONSTRAINT contact_identities_user_id_platform_platform_user_id_key UNIQUE (user_id, platform, platform_user_id);
  END IF;
END $$;

-- Commitment tracking for proactive agency
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

-- Proactive features config
INSERT INTO config (key, value) VALUES
  ('app.proactiveEnabled', '"false"')
ON CONFLICT (key) DO NOTHING;

-- Migration: copy slack_user_tokens → integrations (idempotent)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'slack_user_tokens') THEN
    INSERT INTO integrations (name, enabled, config, secrets, metadata)
    SELECT
      'slack-ws:' || team_id,
      true,
      '{}',
      json_build_object('access_token', access_token)::text,
      json_build_object('team_name', team_name, 'user_id', user_id, 'scopes', scopes)
    FROM slack_user_tokens
    ON CONFLICT (name) DO NOTHING;
  END IF;
END $$;

-- Managed files: disk config files synced to DB for portability
CREATE TABLE IF NOT EXISTS managed_files (
  path        TEXT PRIMARY KEY,            -- relative path, e.g. "SOUL.md", "skills/commit/SKILL.md"
  content     TEXT NOT NULL,
  hash        TEXT NOT NULL,               -- SHA-256 of content (for change detection)
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Per-instance org membership cache (replicated from BA's organization
-- plugin via webhook). The gRPC interceptor checks this on every call to
-- confirm the JWT sub is still a member of NOMOS_ORG_ID before letting
-- the request through. See src/auth/grpc-interceptor.ts.
CREATE TABLE IF NOT EXISTS org_members (
  user_id    TEXT PRIMARY KEY,
  role       TEXT NOT NULL DEFAULT 'member',
  added_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Phase 4b: zero-trust tenant context. Per-user tables get a user_id column
-- so query helpers can enforce per-user filtering against the BA-issued
-- JWT. Single-user (power-user) installs default to 'local' so existing
-- data keeps working without backfill.
DO $$
BEGIN
  -- sessions
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'sessions' AND column_name = 'user_id'
  ) THEN
    ALTER TABLE sessions ADD COLUMN user_id TEXT NOT NULL DEFAULT 'local';
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id, updated_at DESC);
  END IF;

  -- transcript_messages (already FKs to sessions; user_id denormalized for
  -- per-user indexing without a join)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'transcript_messages' AND column_name = 'user_id'
  ) THEN
    ALTER TABLE transcript_messages ADD COLUMN user_id TEXT NOT NULL DEFAULT 'local';
    CREATE INDEX IF NOT EXISTS idx_transcript_user ON transcript_messages(user_id, id);
  END IF;

  -- memory_chunks (already user-scoped semantically; explicit column for RLS)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'memory_chunks' AND column_name = 'user_id'
  ) THEN
    ALTER TABLE memory_chunks ADD COLUMN user_id TEXT NOT NULL DEFAULT 'local';
    CREATE INDEX IF NOT EXISTS idx_memory_user ON memory_chunks(user_id);
  END IF;

  -- user_model
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'user_model' AND column_name = 'user_id'
  ) THEN
    ALTER TABLE user_model ADD COLUMN user_id TEXT NOT NULL DEFAULT 'local';
    CREATE INDEX IF NOT EXISTS idx_user_model_user ON user_model(user_id);
  END IF;

  -- draft_messages
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'draft_messages' AND column_name = 'user_id'
  ) THEN
    ALTER TABLE draft_messages ADD COLUMN user_id TEXT NOT NULL DEFAULT 'local';
    CREATE INDEX IF NOT EXISTS idx_draft_user ON draft_messages(user_id, created_at DESC);
  END IF;

  -- commitments
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'commitments' AND column_name = 'user_id'
  ) THEN
    ALTER TABLE commitments ADD COLUMN user_id TEXT NOT NULL DEFAULT 'local';
    CREATE INDEX IF NOT EXISTS idx_commitments_user ON commitments(user_id, status);
  END IF;

  -- contacts (the user's contact list; subjective per family-plan member)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'contacts' AND column_name = 'user_id'
  ) THEN
    ALTER TABLE contacts ADD COLUMN user_id TEXT NOT NULL DEFAULT 'local';
    CREATE INDEX IF NOT EXISTS idx_contacts_user ON contacts(user_id);
  END IF;

  -- contact_identities
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'contact_identities' AND column_name = 'user_id'
  ) THEN
    ALTER TABLE contact_identities ADD COLUMN user_id TEXT NOT NULL DEFAULT 'local';
    CREATE INDEX IF NOT EXISTS idx_contact_identities_user ON contact_identities(user_id);
  END IF;

  -- cron_jobs
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'cron_jobs' AND column_name = 'user_id'
  ) THEN
    ALTER TABLE cron_jobs ADD COLUMN user_id TEXT NOT NULL DEFAULT 'local';
    CREATE INDEX IF NOT EXISTS idx_cron_user ON cron_jobs(user_id, enabled);
  END IF;

  -- cron_jobs provenance: system (infra crons) | bundled (LOOP.md examples) |
  -- user (CLI/UI) | agent (self-authored). Default 'system' so the existing infra
  -- jobs (wiki-compile, proactive, delta-sync) are labelled correctly on backfill.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'cron_jobs' AND column_name = 'source'
  ) THEN
    ALTER TABLE cron_jobs ADD COLUMN source TEXT NOT NULL DEFAULT 'system'
      CHECK (source IN ('system', 'bundled', 'user', 'agent'));
    CREATE INDEX IF NOT EXISTS idx_cron_source ON cron_jobs(source);
  END IF;

  -- Agent-authored LOOPS carry a distinct 'loop' source so they surface on the Loops
  -- page, not the Tasks/Today surfaces (which are user/assistant scheduled 'agent'
  -- tasks). Widen the source CHECK -- a superset, so all existing rows stay valid.
  ALTER TABLE cron_jobs DROP CONSTRAINT IF EXISTS cron_jobs_source_check;
  ALTER TABLE cron_jobs ADD CONSTRAINT cron_jobs_source_check
    CHECK (source IN ('system', 'bundled', 'user', 'agent', 'loop'));

  -- One-time heal: agent-authored RECURRING jobs created before the 'loop' source
  -- existed (e.g. the proactive "Morning digest" / "Inbox triage" features) are
  -- autonomous loops, not one-off tasks -- but they were tagged 'agent', so they
  -- leaked onto Tasks/Today instead of the Loops page. Reclassify recurring
  -- (cron/every) 'agent' jobs to 'loop'. Guarded by a config marker so it runs
  -- EXACTLY ONCE per database and never reclassifies a later user-scheduled
  -- recurring reminder. One-off ('at') reminders stay 'agent' tasks.
  IF NOT EXISTS (SELECT 1 FROM config WHERE key = 'migrations.reclassified_agent_loops') THEN
    UPDATE cron_jobs SET source = 'loop'
      WHERE source = 'agent' AND schedule_type IN ('cron', 'every');
    INSERT INTO config (key, value)
      VALUES ('migrations.reclassified_agent_loops', 'true'::jsonb)
      ON CONFLICT (key) DO NOTHING;
  END IF;

  -- slack_user_tokens
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'slack_user_tokens' AND column_name = 'user_id'
  ) THEN
    ALTER TABLE slack_user_tokens ADD COLUMN user_id TEXT NOT NULL DEFAULT 'local';
  END IF;

  -- google_accounts (note: separate from the OAuth "user_id" column which
  -- belongs to Google; we name ours owner_user_id to avoid collision).
  -- This table is created at runtime (not in schema.sql), so guard on its
  -- existence — a fresh customer database won't have it yet.
  IF EXISTS (
    SELECT 1 FROM information_schema.tables WHERE table_name = 'google_accounts'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'google_accounts' AND column_name = 'owner_user_id'
  ) THEN
    ALTER TABLE google_accounts ADD COLUMN owner_user_id TEXT NOT NULL DEFAULT 'local';
    CREATE INDEX IF NOT EXISTS idx_google_accounts_owner ON google_accounts(owner_user_id);
  END IF;
END $$;

-- Auto-dream consolidation state. Singleton (id=1).
-- Replaces ~/.nomos/auto-dream/consolidation-state.json.
CREATE TABLE IF NOT EXISTS auto_dream_state (
  id              INT PRIMARY KEY DEFAULT 1,
  last_run_at     TIMESTAMPTZ,
  last_turn_count INT NOT NULL DEFAULT 0,
  total_runs      INT NOT NULL DEFAULT 0,
  state_json      JSONB,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT auto_dream_state_singleton CHECK (id = 1)
);

-- Magic-doc per-file update state.
-- Replaces ~/.nomos/magic-docs-state.json.
CREATE TABLE IF NOT EXISTS magic_doc_state (
  file_path        TEXT PRIMARY KEY,
  last_updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_content_hash TEXT,
  state_json       JSONB
);

-- Mobile device registry: Expo push tokens per user. The agent writes
-- pushes here on draft creation, CATE inbound arrival, and commitment
-- nudges.
CREATE TABLE IF NOT EXISTS mobile_devices (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         TEXT NOT NULL,
  expo_push_token TEXT NOT NULL UNIQUE,
  platform        TEXT NOT NULL CHECK (platform IN ('ios', 'android')),
  app_version     TEXT,
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mobile_devices_user ON mobile_devices(user_id);

-- CATE inbound queue. Backs the mobile Inbox tab. Every inbound CATE
-- envelope is appended here with a trust-tier classification; the user
-- approves/denies/blocks via the mobile app.
CREATE TABLE IF NOT EXISTS cate_inbound (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       TEXT NOT NULL DEFAULT 'local',
  from_did      TEXT NOT NULL,
  from_label    TEXT,
  trust_tier    TEXT NOT NULL DEFAULT 'unknown'
                CHECK (trust_tier IN ('verified', 'bonded', 'friend', 'blocked', 'unknown')),
  subject       TEXT,
  body          TEXT,
  envelope      JSONB NOT NULL,
  bond_amount   NUMERIC,
  bond_currency TEXT,
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'approved', 'denied', 'expired')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  acted_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_cate_inbound_user_status
  ON cate_inbound(user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cate_inbound_from_did ON cate_inbound(from_did);

-- ===========================================================================
-- Knowledge graph (BRAIN). A typed, bitemporal entity/edge overlay over the
-- existing memory stack. Nodes are typed entities that may reference an
-- existing first-class row (a contact, wiki article, memory chunk) by
-- (external_kind, external_ref) instead of duplicating it. Edges are typed,
-- carry provenance, and are bitemporal (valid_at/invalid_at = when true in the
-- world; created_at/expired_at = when the system learned/retracted it). The
-- graph is per-person via user_id (RLS-ready, no org_id — org isolation is the
-- database boundary). See BRAIN_PLAN.md. Requires pg_trgm for fuzzy name match.
-- ===========================================================================
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS kg_nodes (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          TEXT NOT NULL,                 -- person|project|topic|decision|value|event|org|vault|wiki|moc|chunk
  name          TEXT NOT NULL,
  canonical_key TEXT NOT NULL,                 -- dedup key, normalized (lowercased)
  aliases       TEXT[] NOT NULL DEFAULT '{}',  -- Obsidian-style alias resolution
  summary       TEXT,
  embedding     vector(768),                   -- gemini-embedding-001; enables semantic edges
  external_kind TEXT,                           -- 'contact'|'vault'|'wiki'|'memory_chunk'|'user_model'|null
  external_ref  TEXT,                           -- contacts.id | vault_notes.path | wiki_articles.path | memory_chunks.id | …
  attrs         JSONB NOT NULL DEFAULT '{}',
  source_ids    TEXT[] NOT NULL DEFAULT '{}',  -- provenance: memory_chunk ids that created this node
  confidence    REAL NOT NULL DEFAULT 0.5,
  user_id       TEXT NOT NULL DEFAULT 'local', -- per-person scoping (RLS-ready)
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, kind, canonical_key)
);
CREATE INDEX IF NOT EXISTS idx_kg_nodes_kind     ON kg_nodes(kind);
CREATE INDEX IF NOT EXISTS idx_kg_nodes_external  ON kg_nodes(external_kind, external_ref);
CREATE INDEX IF NOT EXISTS idx_kg_nodes_trgm      ON kg_nodes USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_kg_nodes_attrs     ON kg_nodes USING gin(attrs);
CREATE INDEX IF NOT EXISTS idx_kg_nodes_vec_hnsw  ON kg_nodes USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_kg_nodes_user      ON kg_nodes(user_id);

CREATE TABLE IF NOT EXISTS kg_edges (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  src_id        UUID NOT NULL REFERENCES kg_nodes(id) ON DELETE CASCADE,
  dst_id        UUID NOT NULL REFERENCES kg_nodes(id) ON DELETE CASCADE,
  rel_type      TEXT NOT NULL,                 -- works_at|member_of|mentions|links_to|part_of|related_to|derived_from|contradicts|prefers|decided|scheduled_with|semantic_sibling|...
  fact          TEXT,                           -- natural-language assertion (fact-edges)
  origin        TEXT NOT NULL DEFAULT 'explicit', -- explicit|frontmatter|body|mentions|inferred|semantic|manual
  -- writing node, for scoped reconciliation (gbrain). nil-UUID = "none" so the
  -- plain UNIQUE below works without PG15 NULLS NOT DISTINCT.
  origin_node   UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  weight        REAL NOT NULL DEFAULT 1.0,     -- cosine score for semantic edges
  valid_at      TIMESTAMPTZ NOT NULL DEFAULT now(),  -- event timeline: when true in the world
  invalid_at    TIMESTAMPTZ,                    -- NULL = currently true; set on contradiction
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),  -- transaction timeline: when system learned it
  expired_at    TIMESTAMPTZ,                    -- when the system retracted it
  source_ids    TEXT[] NOT NULL DEFAULT '{}',
  attrs         JSONB NOT NULL DEFAULT '{}',
  confidence    REAL NOT NULL DEFAULT 0.5,
  user_id       TEXT NOT NULL DEFAULT 'local',
  UNIQUE (user_id, src_id, dst_id, rel_type, origin, origin_node)
);
CREATE INDEX IF NOT EXISTS idx_kg_edges_src    ON kg_edges(src_id, rel_type);
CREATE INDEX IF NOT EXISTS idx_kg_edges_dst    ON kg_edges(dst_id, rel_type);
CREATE INDEX IF NOT EXISTS idx_kg_edges_live   ON kg_edges(src_id, rel_type) WHERE invalid_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_kg_edges_origin ON kg_edges(origin_node, origin);
CREATE INDEX IF NOT EXISTS idx_kg_edges_attrs  ON kg_edges USING gin(attrs);
CREATE INDEX IF NOT EXISTS idx_kg_edges_user   ON kg_edges(user_id);

-- ── Personality documents (wiki pattern: DB is the source of truth) ──────────
-- Singleton-per-(owner, kind) documents the "Think Like You" features produce
-- (personality DNA, shadow-mode observations). Replaces ~/.nomos/*.json files so
-- the canonical store is the database, per-user scoped, like wiki_articles.
CREATE TABLE IF NOT EXISTS personality_documents (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     TEXT NOT NULL DEFAULT 'local',
  kind        TEXT NOT NULL,                 -- 'dna' | 'shadow_observations'
  content     JSONB NOT NULL DEFAULT '{}',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_personality_docs_user ON personality_documents(user_id);

-- ── Twin-test fidelity scores (history) ──────────────────────────────────────
-- Each /twin-test run records a fidelity score (fraction the discriminator was
-- fooled, 0-1) so "/twin-test score" can show the trend over time. Per-owner.
CREATE TABLE IF NOT EXISTS fidelity_scores (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     TEXT NOT NULL DEFAULT 'local',
  score       REAL NOT NULL,
  pairs       INT  NOT NULL DEFAULT 0,
  fooled      INT  NOT NULL DEFAULT 0,
  detail      JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fidelity_user ON fidelity_scores(user_id, created_at DESC);

-- ── Repair: un-double-encode integrations JSONB ──────────────────────────────
-- Earlier code wrote integrations.config / .metadata via JSON.stringify(...),
-- which the postgres-js driver re-encoded into a json *string* scalar
-- (jsonb_typeof = 'string'). That made config->>'key' read back NULL — e.g. a
-- connected Google account's account_email came through empty, so its MCP was
-- skipped as "no valid token". Unwrap any string-encoded rows back to objects.
-- Idempotent: a no-op once every row is a json object.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'integrations') THEN
    UPDATE integrations SET config = (config #>> '{}')::jsonb
      WHERE jsonb_typeof(config) = 'string';
    UPDATE integrations SET metadata = (metadata #>> '{}')::jsonb
      WHERE jsonb_typeof(metadata) = 'string';
  END IF;
END $$;

-- ── Studio: image assets + edit chains (hosted-only feature) ────────────
-- studio_assets: one row per uploaded original. Blobs live in object storage
-- (org/<id>/studio/...); the row holds the object key + metadata. The original
-- is immutable: edits never mutate it, they append to studio_edits. status is
-- 'pending' until the client confirms its presigned upload; the __studio_gc__
-- sentinel expires unconfirmed rows. head_edit_id is the current chain head
-- (NULL = the original is the head). Per-user scoped on top of db-per-customer.
CREATE TABLE IF NOT EXISTS studio_assets (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       TEXT NOT NULL DEFAULT 'local',
  object_key    TEXT NOT NULL,
  content_hash  TEXT NOT NULL,
  mime          TEXT NOT NULL,
  width         INT,
  height        INT,
  bytes         INT  NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'pending',   -- 'pending' | 'ready' | 'expired'
  head_edit_id  UUID,
  metadata      JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_studio_assets_user   ON studio_assets(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_studio_assets_status ON studio_assets(status, created_at);
CREATE INDEX IF NOT EXISTS idx_studio_assets_hash   ON studio_assets(user_id, content_hash);

-- studio_edits: the non-destructive op chain. Each row is one validated op
-- (src/studio/ops.ts) applied on top of parent_edit_id (NULL = on the original).
-- idempotency_key makes a retried-but-committed edit a no-op (UNIQUE per asset).
-- parent_edit_id + an optimistic head check give a linear chain; a stale parent
-- is rejected. preview_key is the ~256px history preview. identity_score is the
-- face-embedding gate result for face-touching generative ops (NULL = n/a).
-- params is the op params jsonb (stored object, never double-encoded).
CREATE TABLE IF NOT EXISTS studio_edits (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id        UUID NOT NULL REFERENCES studio_assets(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL DEFAULT 'local',
  parent_edit_id  UUID,
  idempotency_key TEXT NOT NULL,
  op              TEXT NOT NULL,
  op_spec_version INT  NOT NULL DEFAULT 1,
  params          JSONB NOT NULL DEFAULT '{}',
  provider        TEXT,
  input_key       TEXT,
  output_key      TEXT,
  preview_key     TEXT,
  status          TEXT NOT NULL DEFAULT 'pending',  -- pending|running|done|failed|expired
  cost_usd        REAL NOT NULL DEFAULT 0,
  identity_score  REAL,
  error           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (asset_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_studio_edits_asset  ON studio_edits(asset_id, created_at);
CREATE INDEX IF NOT EXISTS idx_studio_edits_user   ON studio_edits(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_studio_edits_status ON studio_edits(status, created_at);
CREATE INDEX IF NOT EXISTS idx_studio_edits_parent ON studio_edits(parent_edit_id);
