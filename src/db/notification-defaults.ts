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
