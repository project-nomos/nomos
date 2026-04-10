/**
 * Kysely database interface — compile-time types for all tables.
 *
 * Generated from src/db/schema.sql. Keep in sync when adding columns.
 */

import type { ColumnType, Generated, Insertable, Selectable, Updateable } from "kysely";

// ---------------------------------------------------------------------------
// Table definitions
// ---------------------------------------------------------------------------

export interface ConfigTable {
  key: string;
  /** JSONB — can be any JSON value (string, number, object, array, null). */
  value: ColumnType<unknown, string, string>;
  updated_at: Generated<Date>;
}

export interface SessionsTable {
  id: Generated<string>;
  session_key: string;
  agent_id: Generated<string>;
  model: string | null;
  status: Generated<string>;
  metadata: ColumnType<Record<string, unknown>, string | undefined, string>;
  token_usage: ColumnType<{ input: number; output: number }, string | undefined, string>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  // Migration-added columns
  total_cost_usd: Generated<number>;
  input_tokens: Generated<number>;
  output_tokens: Generated<number>;
  turn_count: Generated<number>;
}

export interface TranscriptMessagesTable {
  id: Generated<number>;
  session_id: string;
  role: string;
  /** JSONB — string or structured content blocks. */
  content: ColumnType<unknown, string, string>;
  usage: ColumnType<{ input: number; output: number } | null, string | null, string | null>;
  created_at: Generated<Date>;
}

export interface MemoryChunksTable {
  id: string;
  source: string;
  path: string | null;
  text: string;
  /** pgvector vector(768) — stored as string, queried via raw SQL operators */
  embedding: ColumnType<string | null, string | null, string | null>;
  start_line: number | null;
  end_line: number | null;
  hash: string | null;
  model: string | null;
  access_count: Generated<number>;
  last_accessed_at: ColumnType<Date | null, Date | null, Date | null>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  metadata: ColumnType<Record<string, unknown>, string | undefined, string>;
}

export interface CronJobsTable {
  id: Generated<string>;
  name: string;
  schedule: string;
  schedule_type: "at" | "every" | "cron";
  session_target: Generated<"main" | "isolated">;
  delivery_mode: Generated<"none" | "announce">;
  prompt: string;
  platform: string | null;
  channel_id: string | null;
  enabled: Generated<boolean>;
  error_count: Generated<number>;
  last_run: ColumnType<Date | null, Date | null, Date | null>;
  last_error: string | null;
  created_at: Generated<Date>;
}

export interface CronRunsTable {
  id: Generated<string>;
  job_id: string;
  job_name: string;
  started_at: Generated<Date>;
  finished_at: ColumnType<Date | null, Date | null, Date | null>;
  success: boolean;
  error: string | null;
  duration_ms: number | null;
  session_key: string | null;
}

export interface PairingRequestsTable {
  id: Generated<string>;
  channel: string;
  platform: string;
  user_id: string;
  code: string;
  status: Generated<string>;
  created_at: Generated<Date>;
  expires_at: Date;
  approved_at: ColumnType<Date | null, Date | null, Date | null>;
}

export interface ChannelAllowlistsTable {
  id: Generated<string>;
  platform: string;
  user_id: string;
  added_by: string | null;
  created_at: Generated<Date>;
}

export interface DraftMessagesTable {
  id: Generated<string>;
  platform: string;
  channel_id: string;
  thread_id: string | null;
  user_id: string;
  in_reply_to: string;
  content: string;
  context: ColumnType<Record<string, unknown>, string | undefined, string>;
  status: Generated<string>;
  created_at: Generated<Date>;
  approved_at: ColumnType<Date | null, Date | null, Date | null>;
  sent_at: ColumnType<Date | null, Date | null, Date | null>;
  expires_at: Date;
}

export interface SlackUserTokensTable {
  id: Generated<string>;
  team_id: string;
  team_name: string;
  user_id: string;
  access_token: string;
  scopes: Generated<string>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface IntegrationsTable {
  id: Generated<string>;
  name: string;
  enabled: Generated<boolean>;
  config: ColumnType<Record<string, unknown>, string | undefined, string>;
  secrets: Generated<string>;
  metadata: ColumnType<Record<string, unknown>, string | undefined, string>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface AgentPermissionsTable {
  id: Generated<string>;
  resource_type: string;
  action: string;
  pattern: string;
  granted_by: string | null;
  created_at: Generated<Date>;
}

export interface UserModelTable {
  id: Generated<string>;
  category: string;
  key: string;
  /** JSONB — can be any JSON value. */
  value: ColumnType<unknown, string, string>;
  source_ids: Generated<string[]>;
  confidence: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface IngestJobsTable {
  id: Generated<string>;
  platform: string;
  source_type: string;
  status: Generated<string>;
  contact: string | null;
  since_date: ColumnType<Date | null, Date | null, Date | null>;
  messages_processed: Generated<number>;
  messages_skipped: Generated<number>;
  last_cursor: string | null;
  error: string | null;
  started_at: Generated<Date>;
  finished_at: ColumnType<Date | null, Date | null, Date | null>;
  last_successful_at: ColumnType<Date | null, Date | null, Date | null>;
  delta_schedule: ColumnType<string | null, string | null, string | null>;
  delta_enabled: Generated<boolean>;
}

export interface StyleProfilesTable {
  id: Generated<string>;
  contact_id: string | null;
  scope: Generated<string>;
  profile: ColumnType<Record<string, unknown>, string | undefined, string>;
  sample_count: Generated<number>;
  last_updated: Generated<Date>;
  created_at: Generated<Date>;
}

export interface WikiArticlesTable {
  id: Generated<string>;
  path: string;
  title: string;
  content: string;
  category: string;
  backlinks: Generated<string[]>;
  word_count: Generated<number>;
  compile_model: string | null;
  compiled_at: Generated<Date>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ContactsTable {
  id: Generated<string>;
  display_name: string;
  role: string | null;
  relationship: ColumnType<Record<string, unknown>, string | undefined, string>;
  autonomy: Generated<"auto" | "draft" | "silent">;
  data_consent: Generated<"inferred" | "explicit" | "withdrawn">;
  notes: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ContactIdentitiesTable {
  id: Generated<string>;
  contact_id: string;
  platform: string;
  platform_user_id: string;
  display_name: string | null;
  email: string | null;
  metadata: ColumnType<Record<string, unknown>, string | undefined, string>;
  created_at: Generated<Date>;
}

export interface CommitmentsTable {
  id: Generated<string>;
  contact_id: string | null;
  description: string;
  source_msg: string | null;
  deadline: ColumnType<Date | null, Date | null, Date | null>;
  status: Generated<"pending" | "completed" | "expired" | "cancelled">;
  reminded: Generated<boolean>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

// ---------------------------------------------------------------------------
// Database interface
// ---------------------------------------------------------------------------

export interface Database {
  config: ConfigTable;
  sessions: SessionsTable;
  transcript_messages: TranscriptMessagesTable;
  memory_chunks: MemoryChunksTable;
  cron_jobs: CronJobsTable;
  cron_runs: CronRunsTable;
  pairing_requests: PairingRequestsTable;
  channel_allowlists: ChannelAllowlistsTable;
  draft_messages: DraftMessagesTable;
  slack_user_tokens: SlackUserTokensTable;
  integrations: IntegrationsTable;
  agent_permissions: AgentPermissionsTable;
  user_model: UserModelTable;
  ingest_jobs: IngestJobsTable;
  style_profiles: StyleProfilesTable;
  wiki_articles: WikiArticlesTable;
  contacts: ContactsTable;
  contact_identities: ContactIdentitiesTable;
  commitments: CommitmentsTable;
}

// ---------------------------------------------------------------------------
// Convenience aliases (Selectable / Insertable / Updateable per table)
// ---------------------------------------------------------------------------

export type Config = Selectable<ConfigTable>;
export type NewConfig = Insertable<ConfigTable>;
export type ConfigUpdate = Updateable<ConfigTable>;

export type Session = Selectable<SessionsTable>;
export type NewSession = Insertable<SessionsTable>;
export type SessionUpdate = Updateable<SessionsTable>;

export type TranscriptMessage = Selectable<TranscriptMessagesTable>;
export type NewTranscriptMessage = Insertable<TranscriptMessagesTable>;

export type MemoryChunk = Selectable<MemoryChunksTable>;
export type NewMemoryChunk = Insertable<MemoryChunksTable>;
export type MemoryChunkUpdate = Updateable<MemoryChunksTable>;

export type CronJob = Selectable<CronJobsTable>;
export type NewCronJob = Insertable<CronJobsTable>;
export type CronJobUpdate = Updateable<CronJobsTable>;

export type CronRun = Selectable<CronRunsTable>;
export type NewCronRun = Insertable<CronRunsTable>;

export type PairingRequest = Selectable<PairingRequestsTable>;
export type NewPairingRequest = Insertable<PairingRequestsTable>;

export type ChannelAllowlist = Selectable<ChannelAllowlistsTable>;
export type NewChannelAllowlist = Insertable<ChannelAllowlistsTable>;

export type DraftMessage = Selectable<DraftMessagesTable>;
export type NewDraftMessage = Insertable<DraftMessagesTable>;
export type DraftMessageUpdate = Updateable<DraftMessagesTable>;

export type SlackUserToken = Selectable<SlackUserTokensTable>;
export type NewSlackUserToken = Insertable<SlackUserTokensTable>;

export type Integration = Selectable<IntegrationsTable>;
export type NewIntegration = Insertable<IntegrationsTable>;
export type IntegrationUpdate = Updateable<IntegrationsTable>;

export type AgentPermission = Selectable<AgentPermissionsTable>;
export type NewAgentPermission = Insertable<AgentPermissionsTable>;

export type UserModel = Selectable<UserModelTable>;
export type NewUserModel = Insertable<UserModelTable>;
export type UserModelUpdate = Updateable<UserModelTable>;

export type IngestJob = Selectable<IngestJobsTable>;
export type NewIngestJob = Insertable<IngestJobsTable>;
export type IngestJobUpdate = Updateable<IngestJobsTable>;

export type StyleProfile = Selectable<StyleProfilesTable>;
export type NewStyleProfile = Insertable<StyleProfilesTable>;
export type StyleProfileUpdate = Updateable<StyleProfilesTable>;

export type WikiArticle = Selectable<WikiArticlesTable>;
export type NewWikiArticle = Insertable<WikiArticlesTable>;
export type WikiArticleUpdate = Updateable<WikiArticlesTable>;

export type Contact = Selectable<ContactsTable>;
export type NewContact = Insertable<ContactsTable>;
export type ContactUpdate = Updateable<ContactsTable>;

export type ContactIdentity = Selectable<ContactIdentitiesTable>;
export type NewContactIdentity = Insertable<ContactIdentitiesTable>;

export type Commitment = Selectable<CommitmentsTable>;
export type NewCommitment = Insertable<CommitmentsTable>;
export type CommitmentUpdate = Updateable<CommitmentsTable>;
