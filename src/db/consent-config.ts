/**
 * Per-platform consent mode configuration.
 *
 * Controls how the agent handles incoming messages from each platform:
 *   - always_ask: draft response, post to default channel for approval
 *   - auto_approve: send immediately, post FYI notification
 *   - notify_only: notify in default channel, no agent response
 *
 * Stored in the config table as `consent.mode.<platform>`.
 */

import { getConfigValue, setConfigValue } from "./config.ts";

export type ConsentMode = "always_ask" | "auto_approve" | "notify_only";

const VALID_MODES: ConsentMode[] = ["always_ask", "auto_approve", "notify_only"];
const CONFIG_PREFIX = "consent.mode.";

/** Known platforms for the consent system. */
const KNOWN_PLATFORMS = ["slack", "discord", "telegram", "imessage", "email", "whatsapp"] as const;
export type ConsentPlatform = (typeof KNOWN_PLATFORMS)[number];

/**
 * Normalize adapter platform strings to base platform names.
 * e.g., "slack-user:T074HACEZ2L" -> "slack", "imessage" -> "imessage"
 */
export function normalizePlatform(platform: string): ConsentPlatform {
  if (platform.startsWith("slack")) return "slack";
  if (platform.startsWith("discord")) return "discord";
  if (platform.startsWith("telegram")) return "telegram";
  if (platform.startsWith("imessage")) return "imessage";
  if (platform.startsWith("email")) return "email";
  if (platform.startsWith("whatsapp")) return "whatsapp";
  return platform as ConsentPlatform;
}

/**
 * Get the consent mode for a platform. Defaults to "always_ask".
 */
export async function getConsentMode(platform: string): Promise<ConsentMode> {
  const key = CONFIG_PREFIX + normalizePlatform(platform);
  const value = await getConfigValue<string>(key);
  if (value && VALID_MODES.includes(value as ConsentMode)) {
    return value as ConsentMode;
  }
  return "always_ask";
}

/**
 * Set the consent mode for a platform.
 */
export async function setConsentMode(platform: string, mode: ConsentMode): Promise<void> {
  if (!VALID_MODES.includes(mode)) {
    throw new Error(`Invalid consent mode: ${mode}`);
  }
  const key = CONFIG_PREFIX + normalizePlatform(platform);
  await setConfigValue(key, mode);
}

/**
 * List consent modes for all known platforms.
 * Returns the configured mode or "always_ask" default for each.
 */
export async function listConsentModes(): Promise<Record<ConsentPlatform, ConsentMode>> {
  const result = {} as Record<ConsentPlatform, ConsentMode>;
  for (const platform of KNOWN_PLATFORMS) {
    result[platform] = await getConsentMode(platform);
  }
  return result;
}
