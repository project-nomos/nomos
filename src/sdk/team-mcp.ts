/**
 * In-process MCP server that lets the agent delegate a complex, parallelizable
 * task to a team of sub-agents IN-LOOP — no `/team` prefix required. The model
 * calls `delegate_to_team` when the user asks to tackle something from multiple
 * angles, compare several options at once, or explicitly asks for a team, in BOTH
 * hosted and power-user modes (both converge on AgentRuntime.runAgent). The
 * synthesized result returns as the tool result, so the agent weaves it into its
 * reply — strictly better than the `/team` early-return, which bypasses the loop.
 *
 * Recursion guard: the TeamTask handed to runTeam carries only the BASE mcp set
 * (which excludes this server), so workers physically never receive the delegate
 * tool and cannot fan out. `isWorkerContext` is a belt-and-suspenders refusal.
 */

import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";
import type { TeamTask } from "../daemon/team-runtime.ts";

export interface TeamMcpDeps {
  /** Run the team end-to-end (decompose → parallel workers → synthesize). */
  runTeam: (
    task: TeamTask,
    emit?: (e: { type: string; message: string }) => void,
  ) => Promise<string>;
  /** Everything-but-the-prompt the team needs (BASE mcp set, perms, model, plugins). */
  teamTaskBase: () => Omit<TeamTask, "prompt">;
  /** True when THIS turn is itself a team worker — block recursive delegation. */
  isWorkerContext: boolean;
  /** Forward team progress to the turn's event stream. */
  onProgress?: (message: string) => void;
}

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
const fail = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });

export function buildTeamMcpServer(deps: TeamMcpDeps): McpSdkServerConfigWithInstance {
  const delegateToTeam = tool(
    "delegate_to_team",
    "Delegate a complex, parallelizable task to a team of parallel sub-agents that research/work independently; their results are synthesized into one answer returned to you. Use it when the user asks to tackle something from multiple angles, compare several options at once, or explicitly asks for a team / parallel work. This is heavyweight — reserve it for genuinely multi-angle or large tasks, not simple single-step ones. The synthesized result comes back to you: weave it into your reply, don't just paste it.",
    {
      task: z
        .string()
        .describe(
          "A complete, self-contained description of the work for the team. Workers cannot see this conversation, so include every bit of context they need.",
        ),
      angles: z
        .array(z.string())
        .optional()
        .describe(
          "Optional explicit sub-angles/perspectives to seed the decomposition (e.g. ['technical feasibility','user demand','competitive landscape']).",
        ),
    },
    async (args) => {
      if (deps.isWorkerContext) {
        return fail(
          "You are a team worker and cannot spawn another team. Complete your assigned subtask directly.",
        );
      }
      const angles =
        args.angles && args.angles.length > 0
          ? `\n\nApproach this from these distinct angles, one per worker:\n${args.angles
              .map((a, i) => `${i + 1}. ${a}`)
              .join("\n")}`
          : "";
      const prompt = `${args.task}${angles}`;
      try {
        const result = await deps.runTeam({ ...deps.teamTaskBase(), prompt }, (e) =>
          deps.onProgress?.(e.message),
        );
        return ok(result || "The team finished but produced no output.");
      } catch (err) {
        return fail(`Team delegation failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  return createSdkMcpServer({
    name: "nomos-team",
    version: "0.1.0",
    tools: [delegateToTeam],
  });
}
