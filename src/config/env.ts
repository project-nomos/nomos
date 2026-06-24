import process from "node:process";
import type { ScopeMode } from "../sessions/types.ts";
import type { ApprovalPolicy } from "../security/tool-approval.ts";
import { getAppConfig, getAppSecrets } from "../db/app-config.ts";
import { ensureEncryptionKey } from "../db/encryption.ts";

/** Model tier configuration for smart routing. */
export interface ModelTiers {
  /** Model for simple queries (greetings, short questions). */
  simple: string;
  /** Model for moderate complexity queries. */
  moderate: string;
  /** Model for complex reasoning, coding, multi-step tasks. */
  complex: string;
}

/** API provider type */
export type ApiProvider = "anthropic" | "vertex" | "openrouter" | "ollama" | "custom";

export interface NomosConfig {
  /** PostgreSQL connection URL */
  databaseUrl?: string;
  /** Active API provider */
  apiProvider: ApiProvider;
  /** Default model to use (passed to SDK) */
  model: string;
  /** Whether to enable smart model routing based on query complexity. */
  smartRouting: boolean;
  /** Model tiers for smart routing. Falls back to `model` for unconfigured tiers. */
  modelTiers: ModelTiers;
  /** Google Cloud project ID (for Vertex AI and embeddings) */
  googleCloudProject?: string;
  /** Location for Vertex AI services like embeddings */
  vertexAiLocation: string;
  /** Embedding model for memory (default: gemini-embedding-001) */
  embeddingModel: string;
  /** Permission mode for the SDK session */
  permissionMode: "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk";
  /** SDK betas to enable (comma-separated in env var) */
  betas?: "context-1m-2025-08-07"[];
  /** Fallback models to use if primary model fails */
  fallbackModels?: string[];
  /** Heartbeat interval in milliseconds (0 = disabled, default: 1800000 = 30 minutes) */
  heartbeatIntervalMs: number;
  /** Opt-in to V2 SDK session API (if available) */
  useV2Sdk?: boolean;
  /** Pairing request TTL in minutes (default: 60) */
  pairingTtlMinutes: number;
  /** Default DM policy: "pairing" | "allowlist" | "open" */
  defaultDmPolicy: "pairing" | "allowlist" | "open";
  /** Session scope mode: "channel" | "sender" | "peer" | "channel-peer" (default: "channel") */
  sessionScope: ScopeMode;
  /** Tool approval policy for dangerous operations (default: "block_critical") */
  toolApprovalPolicy: ApprovalPolicy;
  /** Enable multi-agent team mode (default: false) */
  teamMode: boolean;
  /** Maximum parallel workers for team mode (default: 3) */
  maxTeamWorkers: number;
  /** Budget cap per team worker in USD (default: 2) */
  workerBudgetUsd: number;
  /** Per-turn USD budget ceiling for the main unattended agent loop (unset = no cap) */
  turnBudgetUsd?: number;
  /** Custom Anthropic API base URL (for OpenRouter, Ollama, LiteLLM, etc.) */
  anthropicBaseUrl?: string;
  /** OpenRouter API key (stored separately so provider switching preserves keys) */
  openrouterApiKey?: string;
  /** Enable knowledge extraction and user model learning (default: false) */
  adaptiveMemory: boolean;
  /** Write-time paraphrase enrichment of indexed notes (default on). */
  memoryEnrichment: boolean;
  /** Extract + track commitments from each turn and remind on deadlines (default: false; opt-in -- adds an LLM call per turn) */
  commitmentTracking: boolean;
  /** Analyze the user's writing voice and write in it (default: false; opt-in -- daily analysis + per-turn style guidance) */
  styleMatching: boolean;
  /** Model for knowledge extraction (default: haiku) */
  extractionModel?: string;
  /** Enable the compiled knowledge wiki (default: true). When false the compiler does no work. */
  wikiEnabled?: boolean;
  /** How often the wiki compiler runs / its cooldown, as a duration string (default: "1h"). */
  wikiCompileInterval?: string;
  /** Model for wiki compilation (default: claude-sonnet-4-6). */
  wikiCompileModel?: string;
  /** Cap on articles touched per wiki compilation run (default: 20). */
  wikiMaxArticlesPerRun?: number;
  /** Enable passive behavioral observation (shadow mode) (default: false) */
  shadowMode: boolean;
  /** Enable alternate screen buffer for full-screen TUI experience (default: false) */
  alternateBuffer: boolean;
  /** Enable image generation via Gemini (default: false) */
  imageGeneration: boolean;
  /** Gemini API key for image generation */
  geminiApiKey?: string;
  /** Gemini model for image generation (default: gemini-3-pro-image-preview) */
  imageGenerationModel?: string;
  /** Enable video generation via Veo (default: false) */
  videoGeneration: boolean;
  /** Veo model for video generation (default: veo-3.0-generate-preview) */
  videoGenerationModel?: string;
  /** Use Claude subscription (Max/Pro) instead of API key for agent sessions (default: false) */
  useSubscription: boolean;
  /**
   * Inbox/calendar autonomy level for proactive Gmail + Calendar management.
   * - "off": no automatic inbox or calendar work
   * - "passive": summarize urgent items, no drafts
   * - "active": summarize + create reply drafts via DraftManager
   * - "aggressive": auto-send low-stakes replies (confirmations, RSVPs)
   */
  inboxAutonomy: "off" | "passive" | "active" | "aggressive";
  /** Cron expression for the morning briefing (default: "0 8 * * *" — 8am daily). */
  briefingCron?: string;
  /** Interval for inbox scanning (default: "15m"). Used only when inboxAutonomy !== "off". */
  inboxScanInterval?: string;
  /** Interval for calendar scanning (default: "5m"). Used only when inboxAutonomy !== "off". */
  calendarScanInterval?: string;
  /**
   * Enable the Google Classroom student-assistant capability (default: false; opt-in).
   * Mirrors `FEATURES.classroom()`; toggled via the Extensions page. When false, no
   * Classroom MCP tools, scopes, or proactive scan are loaded.
   */
  classroomEnabled: boolean;
  /**
   * Allow turning in (submitting) approved Classroom homework drafts. Deployment
   * off-switch on top of the per-account read-write scope (default: false). Mirrors
   * `FEATURES.classroomWrite()`. When false, the Classroom write tools are withheld.
   */
  classroomWriteEnabled: boolean;
  /** Run the proactive Classroom due-date / exam-prep scan (default: false; requires classroomEnabled). */
  classroomScan: boolean;
  /** Interval for the Classroom scan (default: "6h"). Used only when classroomScan is on. */
  classroomScanInterval?: string;
}

export function loadEnvConfig(): NomosConfig {
  const betasEnv = process.env.NOMOS_BETAS;
  const fallbackModelsEnv = process.env.NOMOS_FALLBACK_MODELS;
  const isProduction = process.env.NODE_ENV === "production";
  const defaultModel = process.env.NOMOS_MODEL ?? "claude-sonnet-4-6";

  return {
    // Default to a local Postgres instance with `nomos` db -- works out of the
    // box for Homebrew users who run `brew install postgresql && createdb nomos`.
    // Override via DATABASE_URL env var or the Settings UI.
    databaseUrl: process.env.DATABASE_URL ?? "postgresql://localhost:5432/nomos",
    apiProvider: (process.env.NOMOS_API_PROVIDER as ApiProvider) ?? "anthropic",
    model: defaultModel,
    smartRouting: process.env.NOMOS_SMART_ROUTING === "true",
    modelTiers: {
      simple: process.env.NOMOS_MODEL_SIMPLE ?? "claude-haiku-4-5",
      moderate: process.env.NOMOS_MODEL_MODERATE ?? defaultModel,
      complex: process.env.NOMOS_MODEL_COMPLEX ?? defaultModel,
    },
    googleCloudProject: process.env.GOOGLE_CLOUD_PROJECT,
    vertexAiLocation: process.env.VERTEX_AI_LOCATION ?? "global",
    embeddingModel: process.env.EMBEDDING_MODEL ?? "gemini-embedding-001",
    permissionMode:
      (process.env.NOMOS_PERMISSION_MODE as NomosConfig["permissionMode"]) ?? "acceptEdits",
    betas: betasEnv
      ? (betasEnv
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean) as "context-1m-2025-08-07"[])
      : undefined,
    fallbackModels: fallbackModelsEnv
      ? fallbackModelsEnv
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined,
    heartbeatIntervalMs: process.env.HEARTBEAT_INTERVAL_MS
      ? parseInt(process.env.HEARTBEAT_INTERVAL_MS, 10)
      : 1800000,
    useV2Sdk: process.env.NOMOS_USE_V2_SDK === "true",
    pairingTtlMinutes: process.env.PAIRING_TTL_MINUTES
      ? parseInt(process.env.PAIRING_TTL_MINUTES, 10)
      : 60,
    defaultDmPolicy:
      (process.env.DEFAULT_DM_POLICY as "pairing" | "allowlist" | "open") ??
      (isProduction ? "pairing" : "open"),
    sessionScope: (process.env.NOMOS_SESSION_SCOPE as ScopeMode) ?? "channel",
    toolApprovalPolicy: (process.env.TOOL_APPROVAL_POLICY as ApprovalPolicy) ?? "block_critical",
    teamMode: process.env.NOMOS_TEAM_MODE !== "false",
    maxTeamWorkers: process.env.NOMOS_MAX_TEAM_WORKERS
      ? parseInt(process.env.NOMOS_MAX_TEAM_WORKERS, 10)
      : 4,
    workerBudgetUsd: process.env.NOMOS_WORKER_BUDGET_USD
      ? parseFloat(process.env.NOMOS_WORKER_BUDGET_USD)
      : 2,
    turnBudgetUsd: process.env.NOMOS_TURN_BUDGET_USD
      ? parseFloat(process.env.NOMOS_TURN_BUDGET_USD)
      : undefined,
    anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL,
    openrouterApiKey: process.env.OPENROUTER_API_KEY,
    adaptiveMemory: process.env.NOMOS_ADAPTIVE_MEMORY !== "false",
    memoryEnrichment: process.env.NOMOS_MEMORY_ENRICHMENT !== "false",
    // Opt-out (default on): the agent reaches out about your own commitments. The
    // per-turn extraction is cost-gated on a deliverable channel (see memory-indexer),
    // so there's no added cost until reach-out is actually possible.
    commitmentTracking: process.env.NOMOS_COMMITMENT_TRACKING !== "false",
    styleMatching: process.env.NOMOS_STYLE_MATCHING === "true",
    extractionModel: process.env.NOMOS_EXTRACTION_MODEL,
    wikiEnabled: process.env.NOMOS_WIKI_ENABLED !== "false",
    wikiCompileInterval: process.env.NOMOS_WIKI_COMPILE_INTERVAL ?? "1h",
    wikiCompileModel: process.env.NOMOS_WIKI_COMPILE_MODEL ?? "claude-sonnet-4-6",
    wikiMaxArticlesPerRun: process.env.NOMOS_WIKI_MAX_ARTICLES_PER_RUN
      ? parseInt(process.env.NOMOS_WIKI_MAX_ARTICLES_PER_RUN, 10)
      : 20,
    shadowMode: process.env.NOMOS_SHADOW_MODE === "true",
    alternateBuffer: process.env.NOMOS_ALTERNATE_BUFFER === "true",
    imageGeneration: process.env.NOMOS_IMAGE_GENERATION === "true",
    geminiApiKey: process.env.GEMINI_API_KEY,
    imageGenerationModel: process.env.NOMOS_IMAGE_GENERATION_MODEL,
    videoGeneration: process.env.NOMOS_VIDEO_GENERATION === "true",
    videoGenerationModel: process.env.NOMOS_VIDEO_GENERATION_MODEL,
    useSubscription: process.env.NOMOS_USE_SUBSCRIPTION === "true",
    inboxAutonomy: (process.env.NOMOS_INBOX_AUTONOMY as NomosConfig["inboxAutonomy"]) ?? "off",
    briefingCron: process.env.NOMOS_BRIEFING_CRON,
    inboxScanInterval: process.env.NOMOS_INBOX_SCAN_INTERVAL,
    calendarScanInterval: process.env.NOMOS_CALENDAR_SCAN_INTERVAL,
    classroomEnabled: process.env.NOMOS_CLASSROOM === "true",
    classroomWriteEnabled: process.env.NOMOS_CLASSROOM_WRITE === "true",
    classroomScan: process.env.NOMOS_CLASSROOM_SCAN === "true",
    classroomScanInterval: process.env.NOMOS_CLASSROOM_SCAN_INTERVAL,
  };
}

/**
 * Async config loader: DB values > env vars > hardcoded defaults.
 *
 * Reads from the config table and integrations table first, then
 * falls back to env vars via the sync `loadEnvConfig()`.
 *
 * Also ensures an encryption key is available before reading secrets.
 */
export async function loadEnvConfigAsync(): Promise<NomosConfig> {
  // Ensure encryption key exists before any DB secret reads
  ensureEncryptionKey();

  // Start with env-based defaults
  const envConfig = loadEnvConfig();

  try {
    // Load DB config (partial — only keys that exist in DB)
    const dbConfig = await getAppConfig();

    // Load secrets from integrations table
    const anthropic = await getAppSecrets("anthropic");
    const vertexAi = await getAppSecrets("vertex-ai");
    const openrouter = await getAppSecrets("openrouter");
    const database = await getAppSecrets("database");
    const gemini = await getAppSecrets("gemini");

    // Apply DB secrets to env vars so downstream code (SDK, etc.) picks them up
    if (anthropic?.secrets.api_key && !process.env.ANTHROPIC_API_KEY) {
      process.env.ANTHROPIC_API_KEY = anthropic.secrets.api_key;
    }
    if (vertexAi?.config.project_id && !process.env.GOOGLE_CLOUD_PROJECT) {
      process.env.GOOGLE_CLOUD_PROJECT = String(vertexAi.config.project_id);
    }
    if (vertexAi?.config.region && !process.env.CLOUD_ML_REGION) {
      process.env.CLOUD_ML_REGION = String(vertexAi.config.region);
    }
    if (database?.secrets.url && !process.env.DATABASE_URL) {
      process.env.DATABASE_URL = database.secrets.url;
    }

    // Merge: DB values override env defaults
    const merged: NomosConfig = {
      ...envConfig,
      ...dbConfig,
      // Preserve databaseUrl from DB secrets if available
      databaseUrl: database?.secrets.url ?? envConfig.databaseUrl,
      // Preserve googleCloudProject from DB if available
      googleCloudProject: (vertexAi?.config.project_id as string) ?? envConfig.googleCloudProject,
      // Preserve openrouterApiKey from DB if available
      openrouterApiKey: openrouter?.secrets.api_key ?? envConfig.openrouterApiKey,
      // Preserve geminiApiKey from DB if available
      geminiApiKey: gemini?.secrets.api_key ?? envConfig.geminiApiKey,
    };

    // Apply provider-specific env vars based on active provider
    const provider = merged.apiProvider;
    if (provider === "openrouter") {
      const orKey = openrouter?.secrets.api_key ?? envConfig.openrouterApiKey;
      if (orKey) {
        process.env.ANTHROPIC_API_KEY = orKey;
        process.env.ANTHROPIC_BASE_URL = "https://openrouter.ai/api/v1";
        merged.anthropicBaseUrl = "https://openrouter.ai/api/v1";
      }
    } else if (provider === "vertex") {
      process.env.CLAUDE_CODE_USE_VERTEX = "1";
    }

    // Mirror the Classroom capability toggle to the env var the sync FEATURES.classroom()
    // gate reads, so the DB flag (set via the Extensions page) takes effect without
    // editing .env. DB is the source of truth; env is the sync surface the gate reads.
    if (merged.classroomEnabled) process.env.NOMOS_CLASSROOM = "true";
    if (merged.classroomWriteEnabled) process.env.NOMOS_CLASSROOM_WRITE = "true";

    return merged;
  } catch {
    // DB not available (e.g. first run, no migrations yet) — fall back to env-only
    return envConfig;
  }
}

export function validateConfig(cfg: NomosConfig): string[] {
  const errors: string[] = [];

  // SDK handles provider auth via ANTHROPIC_API_KEY or CLAUDE_CODE_USE_VERTEX env vars.
  // We only require DATABASE_URL for our persistence layer.
  if (!cfg.databaseUrl) {
    errors.push("DATABASE_URL is required. Set it to your PostgreSQL connection string.");
  }

  return errors;
}
