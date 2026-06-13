/**
 * Consumer Loops view model -- the pure shaping logic behind MobileApi.ListLoops.
 *
 * The instance runs its background loops as single rows owned by the synthetic
 * `system` tenant, so a hosted user owns none of them and a naive per-user query
 * returns nothing. The consumer Loops page is an audit + control surface, so we
 * ALSO surface a curated set of the always-on "managed" loops under friendly
 * labels. Pure + dependency-free so it is unit-testable in isolation.
 */

import type { CronJob } from "./types.ts";
import { prettifySchedule } from "./schedule-format.ts";

export { prettifySchedule };

export interface ConsumerLoop {
  id: string;
  name: string;
  schedule: string;
  enabled: boolean;
  source: string;
  errorCount: number;
  lastRun: string;
  prompt: string;
}

/** system loop name -> friendly consumer label. Only these `system`-owned loops
 * are surfaced; every other system loop (wiki/graph/magic-docs/delta-sync + the
 * proactive family) is hidden from the consumer. */
export const MANAGED_LOOPS: Record<string, string> = {
  "auto-dream": "Brain consolidation",
  "style-analyze": "Writing style learning",
};

export const MANAGED_LABEL_TO_NAME = new Map(
  Object.entries(MANAGED_LOOPS).map(([name, label]) => [label, name]),
);

function toWire(j: CronJob, over: Partial<ConsumerLoop> = {}): ConsumerLoop {
  return {
    id: j.id,
    name: over.name ?? j.name,
    schedule: prettifySchedule(j.schedule, j.scheduleType),
    enabled: over.enabled ?? j.enabled,
    source: over.source ?? j.source ?? "user",
    errorCount: j.errorCount,
    lastRun: j.lastRun ? j.lastRun.toISOString() : "",
    prompt: "",
  };
}

/**
 * Build the consumer Loops audit list: a curated, friendly-labeled managed set
 * (auto-dream -> "Brain consolidation", style-analyze -> "Writing style
 * learning") owned by the `system` tenant, with the per-user override folded into
 * `enabled`. `optedOut` is the set of managed job NAMES the user has disabled.
 *
 * The user's / agent's own scheduled jobs are NOT shown here -- those are the
 * Tasks surface (see cron/task-view.ts). Loops = the assistant's always-on
 * background behaviors; Tasks = what you/the assistant scheduled.
 */
export function curateConsumerLoops(system: CronJob[], optedOut: Set<string>): ConsumerLoop[] {
  return system
    .filter((j) => MANAGED_LOOPS[j.name])
    .map((j) =>
      toWire(j, {
        name: MANAGED_LOOPS[j.name],
        source: "managed",
        enabled: j.enabled && !optedOut.has(j.name),
      }),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
}
