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

-- Migration: drop unused memory_files table, add cron_runs (idempotent)
DROP TABLE IF EXISTS memory_files;

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

-- Seed config defaults (idempotent — never overwrites user values)
INSERT INTO config (key, value) VALUES
  ('app.model',              '"claude-sonnet-4-6"'),
  ('app.permissionMode',     '"acceptEdits"'),
  ('app.teamMode',           '"true"'),
  ('app.maxTeamWorkers',     '4'),
  ('app.smartRouting',       '"false"'),
  ('app.adaptiveMemory',     '"true"'),
  ('app.extractionModel',    '"claude-haiku-4-5"'),
  ('app.sessionScope',       '"channel"'),
  ('app.toolApprovalPolicy', '"block_critical"'),
  ('app.defaultDmPolicy',    '"open"'),
  ('app.heartbeatIntervalMs','"1800000"')
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
