/**
 * In-process MCP server letting the agent author and manage its OWN autonomous
 * loops (recurring background jobs). Built per turn, scoped to the requesting
 * user, injected in both power-user and hosted modes.
 *
 * A loop is a `cron_jobs` row whose prompt is run as an agent turn on a schedule
 * (the same machinery as the bundled LOOP.md loops + the proactive jobs). Loops
 * the agent creates are tagged `source = 'agent'` and owned by the requesting
 * user, so the user can always audit / disable / delete them from the Settings UI
 * or the iPhone app. The agent has full autonomy here (it can create AND enable),
 * bounded by a per-owner count cap and schedule validation.
 *
 * Tools:
 *   loop_list    — list this owner's loops + status
 *   loop_create  — create a loop (schedule + prompt), optionally enabled
 *   loop_enable  — enable a loop by name
 *   loop_disable — disable a loop by name
 *   loop_update  — change a loop's schedule and/or prompt
 *   loop_delete  — delete an agent-created loop by name
 */

import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";
import process from "node:process";
import { CronExpressionParser } from "cron-parser";
import { CronStore } from "../cron/store.ts";
import { parseInterval } from "../cron/scheduler.ts";
import type { CronJob } from "../cron/types.ts";

/** Context the loop server needs to gate creation + word its replies correctly. */
export interface LoopMcpContext {
  /** True when a cron engine is in-process (the daemon); false in the CLI REPL. */
  hasCronEngine?: boolean;
  /** True when this turn is itself a loop/cron fire (blocks self-replicating loops). */
  isLoopContext?: boolean;
}

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
const fail = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });

/** Stop a single owner's agent from spawning unbounded recurring work. */
const MAX_AGENT_LOOPS = 20;
/** Floor on cadence so the agent cannot schedule a hammering loop. */
const MIN_EVERY_MS = 5 * 60 * 1000; // 5 minutes

/** Validate a schedule string for its type; return an error message or null. */
function validateSchedule(schedule: string, scheduleType: "cron" | "every" | "at"): string | null {
  try {
    if (scheduleType === "every") {
      const ms = parseInterval(schedule);
      if (ms < MIN_EVERY_MS) return `interval too frequent (min 5m), got ${schedule}`;
    } else if (scheduleType === "cron") {
      // Enforce the cadence floor for cron too: a bare "* * * * *" fires every
      // minute (and seconds-field exprs every second), which would spawn
      // overlapping agent turns. Reject anything firing more often than 5m.
      const it = CronExpressionParser.parse(schedule);
      const a = it.next().toDate().getTime();
      const b = it.next().toDate().getTime();
      if (b - a < MIN_EVERY_MS)
        return `cron cadence too frequent (min 5m between runs): ${schedule}`;
    } else {
      if (Number.isNaN(Date.parse(schedule))) return `not a valid ISO timestamp: ${schedule}`;
    }
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

function describeLoop(j: CronJob): string {
  const state = j.enabled ? "enabled" : "disabled";
  const tag = j.source ?? "bundled";
  const errs = j.errorCount > 0 ? `, ${j.errorCount} error(s)` : "";
  const last = j.lastRun ? `, last ran ${j.lastRun.toISOString().slice(0, 16)}` : "";
  return `- ${j.name} [${state}, ${tag}] ${j.scheduleType}:${j.schedule}${last}${errs}`;
}

/** Build the per-user loop-management MCP server. */
export function buildLoopMcpServer(
  userId: string,
  context: LoopMcpContext = {},
): McpSdkServerConfigWithInstance {
  const store = new CronStore();
  const hasCronEngine = context.hasCronEngine ?? true;
  const isLoopContext = context.isLoopContext ?? false;

  const loopList = tool(
    "loop_list",
    "List the autonomous loops you have created (recurring background jobs) with their schedule and status. Use this before creating a loop to avoid duplicates, and to see what is already running.",
    {},
    async () => {
      try {
        // Only the agent's OWN loops are listable/manageable here -- system infra
        // jobs and user-authored loops are not the agent's to surface or toggle.
        const jobs = await store.listJobs({ userId, source: "loop" });
        if (jobs.length === 0) {
          return ok("No autonomous loops yet. Create one with loop_create.");
        }
        const sorted = jobs.sort((a, b) => a.name.localeCompare(b.name));
        return ok(
          `Your autonomous loops (${jobs.length}):\n${sorted.map(describeLoop).join("\n")}`,
        );
      } catch (e) {
        return fail(`loop_list failed: ${e instanceof Error ? e.message : e}`);
      }
    },
    { annotations: { readOnlyHint: true } },
  );

  const loopCreate = tool(
    "loop_create",
    "Create a new autonomous loop: a prompt run as your own agent turn on a recurring schedule. Use this to set up durable background work for yourself (a daily briefing, a periodic check). End the loop's prompt instructions by telling yourself to reply with exactly AUTONOMOUS_OK when there is nothing to do, so silent runs stay silent. The user can always see, disable, or delete loops you create.",
    {
      name: z
        .string()
        .describe("Short kebab-case loop name, e.g. 'daily-standup-prep'. Must be unique."),
      description: z.string().describe("One-line description of what the loop does"),
      schedule: z.string().describe("Schedule value: a cron expr ('0 8 * * *') or interval ('6h')"),
      scheduleType: z
        .enum(["cron", "every"])
        .optional()
        .describe("'cron' for cron expressions (default), 'every' for intervals like '6h'"),
      prompt: z.string().describe("The instructions to run each time the loop fires"),
      enabled: z
        .boolean()
        .optional()
        .describe("Start the loop enabled (default true). Set false to stage it for review."),
      deliveryMode: z
        .enum(["none", "announce"])
        .optional()
        .describe(
          "'none' (silent, default) or 'announce' (post the result to the default channel)",
        ),
    },
    async (args) => {
      try {
        // A loop must not spawn more loops (self-replication). Creating loops is a
        // deliberate, in-conversation act -- not something a running loop does.
        if (isLoopContext) {
          return fail(
            "A running loop can't create new loops. Set up loops in a normal conversation, not from inside a loop's own run.",
          );
        }
        const scheduleType = args.scheduleType ?? "cron";
        const schedErr = validateSchedule(args.schedule, scheduleType);
        if (schedErr) return fail(`Invalid schedule: ${schedErr}`);

        const existing = await store.getJobByName(args.name);
        if (existing) return fail(`A loop named "${args.name}" already exists. Pick another name.`);

        const agentLoops = (await store.listJobs({ userId, source: "loop" })).length;
        if (agentLoops >= MAX_AGENT_LOOPS) {
          return fail(
            `You already have ${agentLoops} self-created loops (max ${MAX_AGENT_LOOPS}). Delete one with loop_delete first.`,
          );
        }

        const enabled = args.enabled ?? true;
        await store.createJob({
          userId,
          name: args.name,
          schedule: args.schedule,
          scheduleType,
          sessionTarget: "isolated",
          deliveryMode: args.deliveryMode ?? "none",
          prompt: args.prompt,
          enabled,
          errorCount: 0,
          source: "loop",
        });
        // Make the cron engine pick up the new job immediately.
        process.emit("cron:refresh" as never);
        const caveat = hasCronEngine
          ? ""
          : " It is saved but only fires while the Nomos daemon is running (start it with `nomos daemon run` or `nomos service install`).";
        return ok(
          `Created loop "${args.name}" (${enabled ? "enabled" : "disabled"}, ${scheduleType}:${args.schedule}).${caveat} The user can manage it in Settings → Loops.`,
        );
      } catch (e) {
        return fail(`loop_create failed: ${e instanceof Error ? e.message : e}`);
      }
    },
  );

  const setEnabled = async (name: string, enabled: boolean) => {
    const job = await store.getJobByName(name);
    // Owner + provenance gate: the agent can only toggle its OWN loops, never a
    // system infra job (which collapses to the same owner id in power-user mode).
    if (!job || job.userId !== userId || job.source !== "agent") {
      return fail(`No agent-created loop named "${name}".`);
    }
    await store.updateJob(job.id, { enabled });
    process.emit("cron:refresh" as never);
    return ok(`${enabled ? "Enabled" : "Disabled"} loop "${name}".`);
  };

  const loopEnable = tool(
    "loop_enable",
    "Enable one of your autonomous loops by name so it starts firing on its schedule.",
    { name: z.string().describe("The loop name") },
    async (args) => {
      try {
        return await setEnabled(args.name, true);
      } catch (e) {
        return fail(`loop_enable failed: ${e instanceof Error ? e.message : e}`);
      }
    },
  );

  const loopDisable = tool(
    "loop_disable",
    "Disable one of your autonomous loops by name (it stays defined but stops firing).",
    { name: z.string().describe("The loop name") },
    async (args) => {
      try {
        return await setEnabled(args.name, false);
      } catch (e) {
        return fail(`loop_disable failed: ${e instanceof Error ? e.message : e}`);
      }
    },
  );

  const loopUpdate = tool(
    "loop_update",
    "Change the schedule and/or the prompt of one of your self-created loops.",
    {
      name: z.string().describe("The loop name"),
      schedule: z.string().optional().describe("New schedule (cron expr or interval)"),
      scheduleType: z.enum(["cron", "every"]).optional().describe("Type of the new schedule"),
      prompt: z.string().optional().describe("New instructions to run each time"),
    },
    async (args) => {
      try {
        const job = await store.getJobByName(args.name);
        // Only self-created loops are editable in-loop; bundled/user loops are the
        // user's to change (Settings UI / CLI), so the agent doesn't rewrite them.
        if (!job || job.userId !== userId || job.source !== "agent") {
          return fail(`No agent-created loop named "${args.name}" to update.`);
        }
        if (args.schedule) {
          const scheduleType = args.scheduleType ?? job.scheduleType;
          const schedErr = validateSchedule(args.schedule, scheduleType as "cron" | "every");
          if (schedErr) return fail(`Invalid schedule: ${schedErr}`);
          await store.updateJob(job.id, { schedule: args.schedule, scheduleType });
        }
        if (args.prompt) await store.updateJob(job.id, { prompt: args.prompt });
        if (!args.schedule && !args.prompt) return fail("Nothing to update.");
        process.emit("cron:refresh" as never);
        return ok(`Updated loop "${args.name}".`);
      } catch (e) {
        return fail(`loop_update failed: ${e instanceof Error ? e.message : e}`);
      }
    },
  );

  const loopDelete = tool(
    "loop_delete",
    "Delete one of your self-created autonomous loops by name. Only loops you created (source 'agent') can be deleted this way.",
    { name: z.string().describe("The loop name to delete") },
    async (args) => {
      try {
        const job = await store.getJobByName(args.name);
        if (!job || job.userId !== userId || job.source !== "agent") {
          return fail(`No agent-created loop named "${args.name}" to delete.`);
        }
        await store.deleteJob(job.id);
        process.emit("cron:refresh" as never);
        return ok(`Deleted loop "${args.name}".`);
      } catch (e) {
        return fail(`loop_delete failed: ${e instanceof Error ? e.message : e}`);
      }
    },
  );

  return createSdkMcpServer({
    name: "nomos-loops",
    version: "1.0.0",
    // Always loaded so loop_create/list/etc. are reachable every turn, not deferred.
    alwaysLoad: true,
    tools: [loopList, loopCreate, loopEnable, loopDisable, loopUpdate, loopDelete],
  });
}
