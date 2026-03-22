import { NextResponse } from "next/server";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readEnv, writeEnv, maskToken } from "@/lib/env";
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
  "NOMOS_TEAM_MODE",
  "NOMOS_MAX_TEAM_WORKERS",
  "ANTHROPIC_BASE_URL",
  "NOMOS_ADAPTIVE_MEMORY",
  "NOMOS_EXTRACTION_MODEL",
  "NOMOS_API_PROVIDER",
  "OPENROUTER_API_KEY",
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
  "NOMOS_TEAM_MODE",
  "NOMOS_MAX_TEAM_WORKERS",
  "ANTHROPIC_BASE_URL",
  "NOMOS_ADAPTIVE_MEMORY",
  "NOMOS_EXTRACTION_MODEL",
  "NOMOS_API_PROVIDER",
  "OPENROUTER_API_KEY",
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
  NOMOS_TEAM_MODE: { table: "config", dbKey: "app.teamMode" },
  NOMOS_MAX_TEAM_WORKERS: { table: "config", dbKey: "app.maxTeamWorkers" },
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

/** Load the encryption key from env or .env file */
function getEncryptionKey(): string | undefined {
  if (process.env.ENCRYPTION_KEY) return process.env.ENCRYPTION_KEY;
  const env = readEnv();
  return env.ENCRYPTION_KEY || undefined;
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
        await sql`
          INSERT INTO config (key, value, updated_at)
          VALUES (${mapping.dbKey}, ${JSON.stringify(value)}, now())
          ON CONFLICT (key) DO UPDATE SET
            value = ${JSON.stringify(value)},
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

      const configJson = JSON.stringify(data.config);
      await sql`
        INSERT INTO integrations (name, enabled, config, secrets, metadata)
        VALUES (${name}, true, ${configJson}::jsonb, ${secretsStr}, '{}'::jsonb)
        ON CONFLICT (name) DO UPDATE SET
          config = ${configJson}::jsonb,
          secrets = ${secretsStr},
          updated_at = now()
      `;
    }

    dbWritten = true;
  } catch {
    // DB not available — will still write to .env
  }

  // Write to .env as secondary sync
  writeEnv(updates);

  return NextResponse.json({
    ok: true,
    updated: Object.keys(updates),
    source: dbWritten ? "db+env" : "env",
  });
}
