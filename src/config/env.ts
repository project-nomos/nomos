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

export interface NomosConfig {
  /** PostgreSQL connection URL */
  databaseUrl?: string;
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
}

export function loadEnvConfig(): NomosConfig {
  const betasEnv = process.env.NOMOS_BETAS;
  const fallbackModelsEnv = process.env.NOMOS_FALLBACK_MODELS;
  const isProduction = process.env.NODE_ENV === "production";
  const defaultModel = process.env.NOMOS_MODEL ?? "claude-sonnet-4-6";

  return {
    databaseUrl: process.env.DATABASE_URL,
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
    const database = await getAppSecrets("database");

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
    return {
      ...envConfig,
      ...dbConfig,
      // Preserve databaseUrl from DB secrets if available
      databaseUrl: database?.secrets.url ?? envConfig.databaseUrl,
      // Preserve googleCloudProject from DB if available
      googleCloudProject:
        (vertexAi?.config.project_id as string) ?? envConfig.googleCloudProject,
    };
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
