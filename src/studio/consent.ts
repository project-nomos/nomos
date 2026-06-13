/**
 * Cloud-AI consent gate. Generative Studio ops send the photo to Google
 * (Vertex/Gemini), so they are gated behind an explicit org-level toggle.
 * Default is OFF: consent is required until the user grants it. Deterministic /
 * on-device ops are NEVER gated. Org-level because the config table is
 * per-customer (database-per-customer). See studio-plan.md section 3 (consent).
 */

import { getConfigValue, setConfigValue } from "../db/config.ts";

export const CLOUD_AI_CONSENT_KEY = "studio.cloud_ai_enabled";

export async function isCloudAIEnabled(): Promise<boolean> {
  return (await getConfigValue<boolean>(CLOUD_AI_CONSENT_KEY)) === true;
}

export async function setCloudAIEnabled(enabled: boolean): Promise<void> {
  await setConfigValue(CLOUD_AI_CONSENT_KEY, enabled);
}

export class ConsentRequiredError extends Error {
  constructor() {
    super("Cloud AI consent required: turn on cloud edits to use generative tools.");
    this.name = "ConsentRequiredError";
  }
}

export async function assertCloudAIConsent(
  isEnabled: () => Promise<boolean> = isCloudAIEnabled,
): Promise<void> {
  if (!(await isEnabled())) throw new ConsentRequiredError();
}
