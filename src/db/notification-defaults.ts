/**
 * Default notification channel — where the agent sends summaries, alerts,
 * and scheduled task results when no explicit target is provided.
 *
 * Stored in the config table as `notifications.default`.
 */

import { getConfigValue, setConfigValue, deleteConfigValue } from "./config.ts";

const CONFIG_KEY = "notifications.default";

export interface NotificationDefault {
  /** Platform identifier, e.g. "slack-user:T074HACEZ2L" */
  platform: string;
  /** Channel or DM ID, e.g. "U073UDQAT0T" (user ID opens DM) */
  channelId: string;
  /** Human-readable label, e.g. "DM in Ingenimax" */
  label?: string;
}

export async function getNotificationDefault(): Promise<NotificationDefault | null> {
  return getConfigValue<NotificationDefault>(CONFIG_KEY);
}

export async function setNotificationDefault(nd: NotificationDefault): Promise<void> {
  await setConfigValue(CONFIG_KEY, nd);
}

export async function clearNotificationDefault(): Promise<void> {
  await deleteConfigValue(CONFIG_KEY);
}

/** Per-owner notification key, e.g. `notifications.default:<userId>`. */
function perOwnerKey(userId: string): string {
  return `${CONFIG_KEY}:${userId}`;
}

/**
 * Resolve the notification target for a specific owner, falling back to the
 * global default. In power-user (one owner = 'local') no per-owner row exists, so
 * this returns the global default and behavior is unchanged. In a hosted
 * multi-member DB each member can set their own target, so proactive deliveries
 * (commitment reminders, triage) reach the right person instead of one shared
 * channel.
 */
export async function getNotificationDefaultFor(
  userId: string,
): Promise<NotificationDefault | null> {
  const own = await getConfigValue<NotificationDefault>(perOwnerKey(userId));
  return own ?? (await getNotificationDefault());
}

export async function setNotificationDefaultFor(
  userId: string,
  nd: NotificationDefault,
): Promise<void> {
  await setConfigValue(perOwnerKey(userId), nd);
}

export async function clearNotificationDefaultFor(userId: string): Promise<void> {
  await deleteConfigValue(perOwnerKey(userId));
}
