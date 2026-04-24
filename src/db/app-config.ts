/**
 * App-level config CRUD: reads from DB config + integrations tables,
 * maps to NomosConfig fields. DB values take precedence over env vars.
 */

import { getConfigValue, setConfigValue } from "./config.ts";
import { getIntegration, upsertIntegration } from "./integrations.ts";
import type { NomosConfig } from "../config/env.ts";

/** Config table key → NomosConfig field mapping */
const CONFIG_KEY_MAP: Record<string, keyof NomosConfig> = {
  "app.model": "model",
  "app.permissionMode": "permissionMode",
  "app.smartRouting": "smartRouting",
  "app.vertexAiLocation": "vertexAiLocation",
  "app.embeddingModel": "embeddingModel",
  "app.heartbeatIntervalMs": "heartbeatIntervalMs",
  "app.pairingTtlMinutes": "pairingTtlMinutes",
  "app.defaultDmPolicy": "defaultDmPolicy",
  "app.sessionScope": "sessionScope",
  "app.toolApprovalPolicy": "toolApprovalPolicy",
  "app.teamMode": "teamMode",
  "app.maxTeamWorkers": "maxTeamWorkers",
  "app.workerBudgetUsd": "workerBudgetUsd",
  "app.apiProvider": "apiProvider",
  "app.anthropicBaseUrl": "anthropicBaseUrl",
  "app.adaptiveMemory": "adaptiveMemory",
  "app.extractionModel": "extractionModel",
  "app.shadowMode": "shadowMode",
  "app.imageGeneration": "imageGeneration",
  "app.imageGenerationModel": "imageGenerationModel",
  "app.videoGeneration": "videoGeneration",
  "app.videoGenerationModel": "videoGenerationModel",
  "app.useSubscription": "useSubscription",
};

/** Reverse map: NomosConfig field → config table key */
const FIELD_TO_KEY: Record<string, string> = {};
for (const [dbKey, field] of Object.entries(CONFIG_KEY_MAP)) {
  FIELD_TO_KEY[field] = dbKey;
}

/**
 * Read app config from the config table.
 * Returns a partial NomosConfig with only keys that exist in DB.
 */
export async function getAppConfig(): Promise<Partial<NomosConfig>> {
  const result: Partial<NomosConfig> = {};

  for (const [dbKey, field] of Object.entries(CONFIG_KEY_MAP)) {
    const value = await getConfigValue(dbKey);
    if (value !== null) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (result as any)[field] = value;
    }
  }

  return result;
}

/**
 * Set a single app config value in the config table.
 * @param field - NomosConfig field name (e.g. "model", "permissionMode")
 * @param value - The value to store
 */
export async function setAppConfig(field: string, value: unknown): Promise<void> {
  const dbKey = FIELD_TO_KEY[field];
  if (!dbKey) {
    throw new Error(`Unknown config field: ${field}`);
  }
  await setConfigValue(dbKey, value);
}

/**
 * Store secrets for a provider in the integrations table (encrypted at rest).
 * @param provider - Integration name (e.g. "anthropic", "vertex-ai", "database")
 * @param secrets - Key-value pairs of secret values
 * @param config - Optional non-secret config to store alongside
 */
export async function setAppSecrets(
  provider: string,
  secrets: Record<string, string>,
  config?: Record<string, unknown>,
): Promise<void> {
  await upsertIntegration(provider, {
    secrets,
    ...(config ? { config } : {}),
  });
}

/**
 * Read secrets for a provider from the integrations table (decrypted).
 * @param provider - Integration name (e.g. "anthropic", "vertex-ai", "database")
 * @returns The decrypted secrets and config, or null if not found
 */
export async function getAppSecrets(
  provider: string,
): Promise<{ secrets: Record<string, string>; config: Record<string, unknown> } | null> {
  const integration = await getIntegration(provider);
  if (!integration) return null;
  return { secrets: integration.secrets, config: integration.config };
}
