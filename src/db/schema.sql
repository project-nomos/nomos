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
  category    TEXT NOT NULL,
  key         TEXT NOT NULL,
  value       JSONB NOT NULL,
  source_ids  TEXT[] NOT NULL DEFAULT '{}',
  confidence  FLOAT NOT NULL DEFAULT 0.5,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (category, key)
);

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
  contact_id   UUID,
  scope        TEXT NOT NULL DEFAULT 'global',
  profile      JSONB NOT NULL DEFAULT '{}',
  sample_count INT NOT NULL DEFAULT 0,
  last_updated TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (contact_id, scope)
);

CREATE INDEX IF NOT EXISTS idx_style_contact ON style_profiles(contact_id);

-- Knowledge wiki articles (DB-primary, disk as cache)
CREATE TABLE IF NOT EXISTS wiki_articles (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  path          TEXT UNIQUE NOT NULL,
  title         TEXT NOT NULL,
  content       TEXT NOT NULL,
  category      TEXT NOT NULL,
  backlinks     TEXT[] NOT NULL DEFAULT '{}',
  word_count    INT NOT NULL DEFAULT 0,
  compile_model TEXT,
  compiled_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wiki_category ON wiki_articles(category);
CREATE INDEX IF NOT EXISTS idx_wiki_path ON wiki_articles(path);
CREATE INDEX IF NOT EXISTS idx_wiki_fts ON wiki_articles
  USING gin(to_tsvector('english', content));

-- Wiki config defaults
INSERT INTO config (key, value) VALUES
  ('app.wikiEnabled',          '"true"'),
  ('app.wikiCompileInterval',  '"2h"'),
  ('app.wikiCompileModel',     '"claude-sonnet-4-6"')
ON CONFLICT (key) DO NOTHING;

-- Unified contacts (cross-platform identity graph)
CREATE TABLE IF NOT EXISTS contacts (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
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
