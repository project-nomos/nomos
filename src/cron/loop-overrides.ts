/**
 * Per-user (per-customer DB) enable/disable override for a managed background
 * loop.
 *
 * The instance's always-on loops (auto-dream, style-analyze, ...) live as a
 * single cron_jobs row owned by the synthetic `system` tenant, so they must not
 * be mutated per-user. Instead the consumer Loops UI toggles a config flag here,
 * and cron-engine consults it at fire time as an AND-gate: a managed loop runs
 * only if its system row is enabled AND the user has not opted out. Absent flag
 * = enabled (default on). In a per-customer DB the config table is the customer's
 * own, so this flag is effectively per-user.
 */

import { getConfigValue, setConfigValue } from "../db/config.ts";

export function userLoopOverrideKey(name: string): string {
  return `app.userLoop.${name}.enabled`;
}

/** True when the user has explicitly turned this loop off. */
export async function isLoopUserDisabled(name: string): Promise<boolean> {
  const v = await getConfigValue(userLoopOverrideKey(name));
  return v === false || v === "false";
}

/** Persist the user's on/off choice for a managed loop. */
export async function setLoopUserEnabled(name: string, enabled: boolean): Promise<void> {
  await setConfigValue(userLoopOverrideKey(name), enabled);
}
