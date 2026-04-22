import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDecipheriv } from "node:crypto";

function getEnvPath(): string {
  // Prefer ~/.nomos/.env so settings persist across Homebrew upgrades
  // and are accessible from any working directory
  const nomosEnv = path.join(os.homedir(), ".nomos", ".env");
  if (fs.existsSync(nomosEnv)) {
    return nomosEnv;
  }

  // Legacy: .env in project root (parent of settings/)
  const projectEnv = path.resolve(process.cwd(), "..", ".env");
  if (fs.existsSync(projectEnv)) {
    return projectEnv;
  }

  // Default to ~/.nomos/.env for new installs
  fs.mkdirSync(path.join(os.homedir(), ".nomos"), { recursive: true });
  return nomosEnv;
}

export function readEnv(): Record<string, string> {
  const envPath = getEnvPath();
  if (!fs.existsSync(envPath)) {
    return {};
  }
  const content = fs.readFileSync(envPath, "utf-8");
  const result: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const eqIdx = trimmed.indexOf("=");
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    result[key] = value;
  }
  return result;
}

export function writeEnv(updates: Record<string, string>): void {
  const envPath = getEnvPath();
  let content = "";
  if (fs.existsSync(envPath)) {
    content = fs.readFileSync(envPath, "utf-8");
  }

  const lines = content.split("\n");
  const updatedKeys = new Set<string>();

  const newLines = lines.map((line) => {
    const trimmed = line.trim();
    // Also match commented-out lines like "# KEY=" so we can uncomment them
    const commentMatch = trimmed.match(/^#\s*([A-Z_][A-Z0-9_]*)=/);
    if (commentMatch) {
      const key = commentMatch[1];
      if (key in updates) {
        updatedKeys.add(key);
        if (updates[key] === "") {
          return `# ${key}=`;
        }
        return `${key}=${updates[key]}`;
      }
      return line;
    }
    if (trimmed.startsWith("#") || !trimmed.includes("=")) return line;
    const eqIdx = trimmed.indexOf("=");
    const key = trimmed.slice(0, eqIdx).trim();
    if (key in updates) {
      updatedKeys.add(key);
      if (updates[key] === "") {
        return `# ${key}=`;
      }
      return `${key}=${updates[key]}`;
    }
    return line;
  });

  // Append keys that weren't already in the file
  for (const [key, value] of Object.entries(updates)) {
    if (!updatedKeys.has(key)) {
      if (value !== "") {
        newLines.push(`${key}=${value}`);
      }
    }
  }

  fs.writeFileSync(envPath, newLines.join("\n"));
}

export function maskToken(token: string): string {
  if (!token || token.length <= 8) return token ? "***" : "";
  return token.slice(0, 8) + "***";
}

// ── DB-aware config reading ──

interface DbMapping {
  table: "config" | "integrations";
  dbKey: string;
  field?: string;
  isSecret?: boolean;
}

/**
 * Mapping from env key names to their database storage location.
 * Kept in sync with the canonical map in /api/env/route.ts.
 */
const ENV_TO_DB: Record<string, DbMapping> = {
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
  ANTHROPIC_API_KEY: {
    table: "integrations",
    dbKey: "anthropic",
    field: "api_key",
    isSecret: true,
  },
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
  IMESSAGE_ENABLED: { table: "integrations", dbKey: "imessage", field: "enabled" },
  IMESSAGE_MODE: { table: "integrations", dbKey: "imessage", field: "mode" },
  IMESSAGE_ALLOWED_CHATS: { table: "integrations", dbKey: "imessage", field: "allowed_chats" },
  BLUEBUBBLES_SERVER_URL: { table: "integrations", dbKey: "imessage", field: "server_url" },
  BLUEBUBBLES_PASSWORD: {
    table: "integrations",
    dbKey: "imessage",
    field: "password",
    isSecret: true,
  },
  BLUEBUBBLES_WEBHOOK_PORT: { table: "integrations", dbKey: "imessage", field: "webhook_port" },
  BLUEBUBBLES_READ_RECEIPTS: { table: "integrations", dbKey: "imessage", field: "read_receipts" },
  OPENROUTER_API_KEY: {
    table: "integrations",
    dbKey: "openrouter",
    field: "api_key",
    isSecret: true,
  },
  DATABASE_URL: { table: "integrations", dbKey: "database", field: "url", isSecret: true },
  NOMOS_MODEL: { table: "config", dbKey: "app.model" },
  NOMOS_PERMISSION_MODE: { table: "config", dbKey: "app.permissionMode" },
  NOMOS_SMART_ROUTING: { table: "config", dbKey: "app.smartRouting" },
  NOMOS_MODEL_SIMPLE: { table: "config", dbKey: "app.modelSimple" },
  NOMOS_MODEL_MODERATE: { table: "config", dbKey: "app.modelModerate" },
  NOMOS_MODEL_COMPLEX: { table: "config", dbKey: "app.modelComplex" },
  NOMOS_TEAM_MODE: { table: "config", dbKey: "app.teamMode" },
  NOMOS_MAX_TEAM_WORKERS: { table: "config", dbKey: "app.maxTeamWorkers" },
  NOMOS_API_PROVIDER: { table: "config", dbKey: "app.apiProvider" },
  ANTHROPIC_BASE_URL: { table: "config", dbKey: "app.anthropicBaseUrl" },
  NOMOS_ADAPTIVE_MEMORY: { table: "config", dbKey: "app.adaptiveMemory" },
  NOMOS_EXTRACTION_MODEL: { table: "config", dbKey: "app.extractionModel" },
  CLAUDE_CODE_USE_VERTEX: { table: "integrations", dbKey: "vertex-ai", field: "enabled" },
  GOOGLE_CLOUD_PROJECT: { table: "integrations", dbKey: "vertex-ai", field: "project_id" },
  CLOUD_ML_REGION: { table: "integrations", dbKey: "vertex-ai", field: "region" },
};

function tryDecryptSecret(encrypted: string, encryptionKey: string | undefined): string {
  if (!encryptionKey || !encrypted) return encrypted;
  const parts = encrypted.split(".");
  if (parts.length !== 3) return encrypted;

  try {
    const key = Buffer.from(encryptionKey, "hex");
    const [ivHex, ciphertextHex, tagHex] = parts;
    const iv = Buffer.from(ivHex!, "hex");
    const ciphertext = Buffer.from(ciphertextHex!, "hex");
    const tag = Buffer.from(tagHex!, "hex");
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString("utf8");
  } catch {
    return encrypted;
  }
}

function getEncryptionKey(): string | undefined {
  if (process.env.ENCRYPTION_KEY) return process.env.ENCRYPTION_KEY;
  const env = readEnv();
  return env.ENCRYPTION_KEY || undefined;
}

/**
 * Read config values with DB-first fallback to .env.
 *
 * For each requested key, tries the database (integrations/config tables)
 * first, then falls back to the .env file. This is the correct way to read
 * config throughout the settings app -- use this instead of raw readEnv()
 * when you need values that may be stored in the DB.
 */
export async function readConfig(
  keys: string[],
  sql?: import("postgres").Sql,
): Promise<Record<string, string>> {
  const envFile = readEnv();
  const result: Record<string, string> = {};
  const encryptionKey = getEncryptionKey();

  for (const key of keys) {
    let value: string | undefined;

    // Try DB first
    if (sql) {
      const mapping = ENV_TO_DB[key];
      if (mapping) {
        try {
          if (mapping.table === "config") {
            const [row] = await sql<[{ value: unknown }?]>`
              SELECT value FROM config WHERE key = ${mapping.dbKey}
            `;
            if (row?.value != null) value = String(row.value);
          } else {
            const [row] = await sql<[{ config: Record<string, unknown>; secrets: string }?]>`
              SELECT config, secrets FROM integrations WHERE name = ${mapping.dbKey}
            `;
            if (row) {
              if (mapping.isSecret && mapping.field) {
                if (row.secrets) {
                  const decrypted = tryDecryptSecret(row.secrets, encryptionKey);
                  try {
                    const parsed = JSON.parse(decrypted) as Record<string, string>;
                    value = parsed[mapping.field] || undefined;
                  } catch {
                    // decrypt/parse failed
                  }
                }
              } else if (mapping.field) {
                const val = row.config[mapping.field];
                if (val != null) value = String(val);
              }
            }
          }
        } catch {
          // DB query failed -- fall through to .env
        }
      }
    }

    // Fall back to .env file
    if (!value) {
      value = envFile[key];
    }

    if (value) {
      result[key] = value;
    }
  }

  return result;
}
