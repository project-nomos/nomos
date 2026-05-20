import { NextResponse } from "next/server";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { readEnv, writeEnv, maskToken, readConfig } from "@/lib/env";
import { validateOrigin } from "@/lib/validate-request";
import { getDb } from "@/lib/db";

/** Keys that are relevant to integrations and safe to expose (masked). */
const ALLOWED_KEYS = [
  "SLACK_APP_TOKEN",
  "SLACK_BOT_TOKEN",
  "SLACK_CLIENT_ID",
  "SLACK_CLIENT_SECRET",
  "GOOGLE_OAUTH_CLIENT_ID",
  "GOOGLE_OAUTH_CLIENT_SECRET",
  "GWS_SERVICES",
  "DATABASE_URL",
  "ANTHROPIC_API_KEY",
  "ENCRYPTION_KEY",
  "NOMOS_MODEL",
  "NOMOS_PERMISSION_MODE",
  "DAEMON_PORT",
  "DISCORD_BOT_TOKEN",
  "DISCORD_ALLOWED_CHANNELS",
  "DISCORD_ALLOWED_GUILDS",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_ALLOWED_CHATS",
  "WHATSAPP_ENABLED",
  "WHATSAPP_ALLOWED_CHATS",
  "CLAUDE_CODE_USE_VERTEX",
  "GOOGLE_CLOUD_PROJECT",
  "CLOUD_ML_REGION",
  "NOMOS_SMART_ROUTING",
  "NOMOS_MODEL_SIMPLE",
  "NOMOS_MODEL_MODERATE",
  "NOMOS_MODEL_COMPLEX",
  "NOMOS_USE_SUBSCRIPTION",
  "NOMOS_TEAM_MODE",
  "NOMOS_MAX_TEAM_WORKERS",
  "NOMOS_WORKER_BUDGET_USD",
  "ANTHROPIC_BASE_URL",
  "NOMOS_ADAPTIVE_MEMORY",
  "NOMOS_EXTRACTION_MODEL",
  "NOMOS_API_PROVIDER",
  "OPENROUTER_API_KEY",
  "NOMOS_BROWSER_AUTH",
  "IMESSAGE_ENABLED",
  "IMESSAGE_FEATURE_MODE",
  "IMESSAGE_AGENT_MODE",
  "IMESSAGE_OWNER_PHONE",
  "IMESSAGE_OWNER_APPLE_ID",
  "GOOGLE_API_KEY",
  "EMBEDDING_MODEL",
  "NOMOS_IMAGE_GENERATION",
  "NOMOS_IMAGE_GENERATION_MODEL",
  "NOMOS_VIDEO_GENERATION",
  "NOMOS_VIDEO_GENERATION_MODEL",
];

/** Keys that contain secrets and should be masked in GET responses. */
const SECRET_KEYS = new Set([
  "SLACK_APP_TOKEN",
  "SLACK_BOT_TOKEN",
  "SLACK_CLIENT_SECRET",
  "GOOGLE_OAUTH_CLIENT_SECRET",
  "DATABASE_URL",
  "ANTHROPIC_API_KEY",
  "ENCRYPTION_KEY",
  "DISCORD_BOT_TOKEN",
  "TELEGRAM_BOT_TOKEN",
  "OPENROUTER_API_KEY",
  "GOOGLE_API_KEY",
]);

/** Keys that are writable via PUT. */
const WRITABLE_KEYS = new Set([
  "SLACK_APP_TOKEN",
  "SLACK_BOT_TOKEN",
  "SLACK_CLIENT_ID",
  "SLACK_CLIENT_SECRET",
  "GOOGLE_OAUTH_CLIENT_ID",
  "GOOGLE_OAUTH_CLIENT_SECRET",
  "GWS_SERVICES",
  "ANTHROPIC_API_KEY",
  "ENCRYPTION_KEY",
  "NOMOS_MODEL",
  "NOMOS_PERMISSION_MODE",
  "DAEMON_PORT",
  "DISCORD_BOT_TOKEN",
  "DISCORD_ALLOWED_CHANNELS",
  "DISCORD_ALLOWED_GUILDS",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_ALLOWED_CHATS",
  "WHATSAPP_ENABLED",
  "WHATSAPP_ALLOWED_CHATS",
  "CLAUDE_CODE_USE_VERTEX",
  "GOOGLE_CLOUD_PROJECT",
  "CLOUD_ML_REGION",
  "NOMOS_SMART_ROUTING",
  "NOMOS_MODEL_SIMPLE",
  "NOMOS_MODEL_MODERATE",
  "NOMOS_MODEL_COMPLEX",
  "NOMOS_USE_SUBSCRIPTION",
  "NOMOS_TEAM_MODE",
  "NOMOS_MAX_TEAM_WORKERS",
  "NOMOS_WORKER_BUDGET_USD",
  "ANTHROPIC_BASE_URL",
  "NOMOS_ADAPTIVE_MEMORY",
  "NOMOS_EXTRACTION_MODEL",
  "NOMOS_API_PROVIDER",
  "OPENROUTER_API_KEY",
  "IMESSAGE_ENABLED",
  "IMESSAGE_FEATURE_MODE",
  "IMESSAGE_AGENT_MODE",
  "IMESSAGE_OWNER_PHONE",
  "IMESSAGE_OWNER_APPLE_ID",
  "GOOGLE_API_KEY",
  "EMBEDDING_MODEL",
  "NOMOS_IMAGE_GENERATION",
  "NOMOS_IMAGE_GENERATION_MODEL",
  "NOMOS_VIDEO_GENERATION",
  "NOMOS_VIDEO_GENERATION_MODEL",
]);

/**
 * Mapping: env key → { table, dbKey, integration?, secretField? }
 *
 * Config table keys use "app." prefix.
 * Integration table entries use the integration name + field.
 */
interface DbMapping {
  table: "config" | "integrations";
  /** For config table: the key in the config table. For integrations: the integration name. */
  dbKey: string;
  /** For integrations: whether the value is a secret or config field */
  field?: string;
  isSecret?: boolean;
}

const ENV_TO_DB: Record<string, DbMapping> = {
  NOMOS_MODEL: { table: "config", dbKey: "app.model" },
  NOMOS_PERMISSION_MODE: { table: "config", dbKey: "app.permissionMode" },
  DAEMON_PORT: { table: "config", dbKey: "app.daemonPort" },
  ANTHROPIC_API_KEY: {
    table: "integrations",
    dbKey: "anthropic",
    field: "api_key",
    isSecret: true,
  },
  GOOGLE_CLOUD_PROJECT: { table: "integrations", dbKey: "vertex-ai", field: "project_id" },
  CLOUD_ML_REGION: { table: "integrations", dbKey: "vertex-ai", field: "region" },
  DATABASE_URL: { table: "integrations", dbKey: "database", field: "url", isSecret: true },
  SLACK_APP_TOKEN: { table: "integrations", dbKey: "slack", field: "app_token", isSecret: true },
  SLACK_BOT_TOKEN: { table: "integrations", dbKey: "slack", field: "bot_token", isSecret: true },
  SLACK_CLIENT_ID: { table: "integrations", dbKey: "slack", field: "client_id" },
  SLACK_CLIENT_SECRET: {
    table: "integrations",
    dbKey: "slack",
    field: "client_secret",
    isSecret: true,
  },
  GOOGLE_OAUTH_CLIENT_ID: { table: "integrations", dbKey: "google", field: "client_id" },
  GOOGLE_OAUTH_CLIENT_SECRET: {
    table: "integrations",
    dbKey: "google",
    field: "client_secret",
    isSecret: true,
  },
  GWS_SERVICES: { table: "integrations", dbKey: "google", field: "services" },
  DISCORD_BOT_TOKEN: {
    table: "integrations",
    dbKey: "discord",
    field: "bot_token",
    isSecret: true,
  },
  DISCORD_ALLOWED_CHANNELS: { table: "integrations", dbKey: "discord", field: "allowed_channels" },
  DISCORD_ALLOWED_GUILDS: { table: "integrations", dbKey: "discord", field: "allowed_guilds" },
  TELEGRAM_BOT_TOKEN: {
    table: "integrations",
    dbKey: "telegram",
    field: "bot_token",
    isSecret: true,
  },
  TELEGRAM_ALLOWED_CHATS: { table: "integrations", dbKey: "telegram", field: "allowed_chats" },
  WHATSAPP_ENABLED: { table: "integrations", dbKey: "whatsapp", field: "enabled" },
  WHATSAPP_ALLOWED_CHATS: { table: "integrations", dbKey: "whatsapp", field: "allowed_chats" },
  NOMOS_SMART_ROUTING: { table: "config", dbKey: "app.smartRouting" },
  NOMOS_MODEL_SIMPLE: { table: "config", dbKey: "app.modelSimple" },
  NOMOS_MODEL_MODERATE: { table: "config", dbKey: "app.modelModerate" },
  NOMOS_MODEL_COMPLEX: { table: "config", dbKey: "app.modelComplex" },
  NOMOS_USE_SUBSCRIPTION: { table: "config", dbKey: "app.useSubscription" },
  NOMOS_TEAM_MODE: { table: "config", dbKey: "app.teamMode" },
  NOMOS_MAX_TEAM_WORKERS: { table: "config", dbKey: "app.maxTeamWorkers" },
  NOMOS_WORKER_BUDGET_USD: { table: "config", dbKey: "app.workerBudgetUsd" },
  NOMOS_API_PROVIDER: { table: "config", dbKey: "app.apiProvider" },
  ANTHROPIC_BASE_URL: { table: "config", dbKey: "app.anthropicBaseUrl" },
  OPENROUTER_API_KEY: {
    table: "integrations",
    dbKey: "openrouter",
    field: "api_key",
    isSecret: true,
  },
  NOMOS_ADAPTIVE_MEMORY: { table: "config", dbKey: "app.adaptiveMemory" },
  NOMOS_EXTRACTION_MODEL: { table: "config", dbKey: "app.extractionModel" },
  NOMOS_IMAGE_GENERATION: { table: "config", dbKey: "app.imageGeneration" },
  NOMOS_IMAGE_GENERATION_MODEL: { table: "config", dbKey: "app.imageGenerationModel" },
  GEMINI_API_KEY: {
    table: "integrations",
    dbKey: "gemini",
    field: "api_key",
    isSecret: true,
  },
  NOMOS_VIDEO_GENERATION: { table: "config", dbKey: "app.videoGeneration" },
  NOMOS_VIDEO_GENERATION_MODEL: { table: "config", dbKey: "app.videoGenerationModel" },
  GOOGLE_API_KEY: { table: "integrations", dbKey: "google-ai", field: "api_key", isSecret: true },
  EMBEDDING_MODEL: { table: "config", dbKey: "app.embeddingModel" },
  IMESSAGE_ENABLED: { table: "integrations", dbKey: "imessage", field: "enabled" },
  IMESSAGE_FEATURE_MODE: { table: "integrations", dbKey: "imessage", field: "feature_mode" },
  IMESSAGE_AGENT_MODE: { table: "integrations", dbKey: "imessage", field: "agent_mode" },
  IMESSAGE_OWNER_PHONE: { table: "integrations", dbKey: "imessage", field: "owner_phone" },
  IMESSAGE_OWNER_APPLE_ID: { table: "integrations", dbKey: "imessage", field: "owner_apple_id" },
};

/** Simple decrypt: if the value looks encrypted (three dot-separated hex segments), try to decrypt. */
function tryDecryptSecret(encrypted: string, encryptionKey: string | undefined): string {
  if (!encryptionKey || !encrypted) return encrypted;
  const parts = encrypted.split(".");
  if (parts.length !== 3) return encrypted;

  try {
    const key = Buffer.from(encryptionKey, "hex");
    const [ivHex, ciphertextHex, tagHex] = parts;
    const iv = Buffer.from(ivHex, "hex");
    const ciphertext = Buffer.from(ciphertextHex, "hex");
    const tag = Buffer.from(tagHex, "hex");
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString("utf8");
  } catch {
    return encrypted;
  }
}

/** Read a value from the DB for a given env key. */
async function readDbValue(
  sql: ReturnType<typeof getDb>,
  envKey: string,
  encryptionKey: string | undefined,
): Promise<string | undefined> {
  const mapping = ENV_TO_DB[envKey];
  if (!mapping) return undefined;

  try {
    if (mapping.table === "config") {
      const [row] = await sql<[{ value: unknown }?]>`
        SELECT value FROM config WHERE key = ${mapping.dbKey}
      `;
      if (row?.value != null) return String(row.value);
    } else {
      const [row] = await sql<[{ config: Record<string, unknown>; secrets: string }?]>`
        SELECT config, secrets FROM integrations WHERE name = ${mapping.dbKey}
      `;
      if (!row) return undefined;

      if (mapping.isSecret && mapping.field) {
        // Secrets are stored as encrypted JSON string
        if (row.secrets) {
          const decrypted = tryDecryptSecret(row.secrets, encryptionKey);
          try {
            const parsed = JSON.parse(decrypted) as Record<string, string>;
            return parsed[mapping.field] || undefined;
          } catch {
            return undefined;
          }
        }
      } else if (mapping.field) {
        const val = row.config[mapping.field];
        return val != null ? String(val) : undefined;
      }
    }
  } catch {
    // DB query failed — return undefined (caller falls back to .env)
  }
  return undefined;
}

/** Load the encryption key. Priority: env -> .env file -> ~/.nomos/encryption.key.
 * The last fallback matches the daemon's `ensureEncryptionKey()` so the
 * Settings UI encrypts with the same key whether it runs as a daemon
 * child (env set) or standalone in dev (only the keyfile is available).
 */
function getEncryptionKey(): string | undefined {
  if (process.env.ENCRYPTION_KEY) return process.env.ENCRYPTION_KEY;
  const env = readEnv();
  if (env.ENCRYPTION_KEY) return env.ENCRYPTION_KEY;
  try {
    const keyFile = path.join(os.homedir(), ".nomos", "encryption.key");
    if (fs.existsSync(keyFile)) {
      const key = fs.readFileSync(keyFile, "utf-8").trim();
      if (key.length === 64) {
        // Cache in process.env so subsequent lookups are cheap.
        process.env.ENCRYPTION_KEY = key;
        return key;
      }
    }
  } catch {
    // ignore — fall through to undefined
  }
  return undefined;
}

export async function GET() {
  const envFile = readEnv();
  const result: Record<string, string> = {};
  const encryptionKey = getEncryptionKey();

  let sql: ReturnType<typeof getDb> | null = null;
  try {
    sql = getDb();
  } catch {
    // DB not available — fall through to .env-only
  }

  for (const key of ALLOWED_KEYS) {
    let value: string | undefined;

    // Try DB first
    if (sql) {
      value = await readDbValue(sql, key, encryptionKey);
    }

    // Fall back to .env file
    if (!value) {
      value = envFile[key];
    }

    if (value) {
      result[key] = SECRET_KEYS.has(key) ? maskToken(value) : value;
    }
  }

  return NextResponse.json(result);
}

/** Group updates by integration name for batch upserts. */
interface IntegrationUpdate {
  config: Record<string, unknown>;
  secrets: Record<string, string>;
}

export async function PUT(request: Request) {
  const forbidden = validateOrigin(request);
  if (forbidden) return forbidden;

  const body = (await request.json()) as Record<string, string>;

  // Filter to only writable keys
  const updates: Record<string, string> = {};
  for (const [key, value] of Object.entries(body)) {
    if (WRITABLE_KEYS.has(key) && typeof value === "string") {
      updates[key] = value;
    }
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "No valid keys to update" }, { status: 400 });
  }

  // Write to DB (primary)
  let dbWritten = false;
  try {
    const sql = getDb();
    const encryptionKey = getEncryptionKey();

    // Group integration updates by integration name
    const integrationUpdates = new Map<string, IntegrationUpdate>();

    for (const [key, value] of Object.entries(updates)) {
      const mapping = ENV_TO_DB[key];
      if (!mapping) continue;

      if (mapping.table === "config") {
        const jsonValue = sql.json(value as string);
        await sql`
          INSERT INTO config (key, value, updated_at)
          VALUES (${mapping.dbKey}, ${jsonValue}, now())
          ON CONFLICT (key) DO UPDATE SET
            value = ${jsonValue},
            updated_at = now()
        `;
      } else if (mapping.field) {
        // Collect integration updates to batch per integration
        let entry = integrationUpdates.get(mapping.dbKey);
        if (!entry) {
          entry = { config: {}, secrets: {} };
          // Load existing values from DB
          const [existing] = await sql<
            [{ config: Record<string, unknown>; secrets: string }?]
          >`SELECT config, secrets FROM integrations WHERE name = ${mapping.dbKey}`;

          if (existing) {
            entry.config = existing.config ?? {};
            if (existing.secrets) {
              try {
                const decrypted = tryDecryptSecret(existing.secrets, encryptionKey);
                entry.secrets = JSON.parse(decrypted);
              } catch {
                entry.secrets = {};
              }
            }
          }
          integrationUpdates.set(mapping.dbKey, entry);
        }

        if (mapping.isSecret) {
          entry.secrets[mapping.field] = value;
        } else {
          entry.config[mapping.field] = value;
        }
      }
    }

    // Write grouped integration updates
    for (const [name, data] of integrationUpdates) {
      const secretsJson = JSON.stringify(data.secrets);
      // Encrypt secrets if key is available
      let secretsStr = secretsJson;
      if (encryptionKey && encryptionKey.length === 64) {
        try {
          const keyBuf = Buffer.from(encryptionKey, "hex");
          const iv = randomBytes(12);
          const cipher = createCipheriv("aes-256-gcm", keyBuf, iv);
          const encrypted = Buffer.concat([cipher.update(secretsJson, "utf8"), cipher.final()]);
          const tag = cipher.getAuthTag();
          secretsStr = `${iv.toString("hex")}.${encrypted.toString("hex")}.${tag.toString("hex")}`;
        } catch {
          // Fall back to plaintext
        }
      }

      await sql`
        INSERT INTO integrations (name, enabled, config, secrets, metadata)
        VALUES (${name}, true, ${sql.json(data.config as Record<string, string>)}, ${secretsStr}, '{}'::jsonb)
        ON CONFLICT (name) DO UPDATE SET
          config = ${sql.json(data.config as Record<string, string>)},
          secrets = ${secretsStr},
          updated_at = now()
      `;
    }

    dbWritten = true;
  } catch {
    // DB not available — will still write to .env
  }

  // Write non-secret config to .env as convenience (for bootstrap / CLI use).
  // Secrets are ONLY stored in the DB (encrypted) to avoid duplication issues
  // where .env tokens cause duplicate adapter registrations on daemon start.
  const envUpdates: Record<string, string> = {};
  for (const [key, value] of Object.entries(updates)) {
    if (!SECRET_KEYS.has(key)) {
      envUpdates[key] = value;
    }
  }
  if (Object.keys(envUpdates).length > 0) {
    writeEnv(envUpdates);
  }

  // If any of the Google OAuth credentials changed, also rewrite
  // ~/.config/gws/client_secret.json so the @googleworkspace/cli picks up
  // the new Client ID / Secret / Project ID without requiring a full
  // re-authorization. Saving the Project ID alone is enough now -- before
  // this, a stale project_id silently broke every Gmail/Calendar/Drive
  // call with "Project 'projects/<placeholder>' not found or deleted".
  const gwsKeys = new Set([
    "GOOGLE_OAUTH_CLIENT_ID",
    "GOOGLE_OAUTH_CLIENT_SECRET",
    "GOOGLE_CLOUD_PROJECT",
  ]);
  const touchedGws = Object.keys(updates).some((k) => gwsKeys.has(k));
  if (touchedGws) {
    try {
      const { writeGwsClientSecret } = await import("@/lib/sync-gws-client-secret");
      // Read the current canonical values (DB > .env), since the user may
      // have only changed one of the three fields.
      let gwsSql: ReturnType<typeof getDb> | undefined;
      try {
        gwsSql = getDb();
      } catch {
        gwsSql = undefined;
      }
      const env = await readConfig(
        ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET", "GOOGLE_CLOUD_PROJECT"],
        gwsSql,
      );
      writeGwsClientSecret({
        clientId: env.GOOGLE_OAUTH_CLIENT_ID ?? "",
        clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET ?? "",
        projectId: env.GOOGLE_CLOUD_PROJECT ?? "",
      });
    } catch (err) {
      console.warn(
        "[env] Failed to sync gws client_secret.json:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  return NextResponse.json({
    ok: true,
    updated: Object.keys(updates),
    source: dbWritten ? "db" : "env",
  });
}
