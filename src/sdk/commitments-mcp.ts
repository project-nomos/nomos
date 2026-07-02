/**
 * In-process MCP server exposing the agent's ACTION LIST as tools (the vault-mcp
 * pattern). Built per turn, scoped to the requesting user, injected in both
 * power-user and hosted modes.
 *
 * The `commitments` table is the single durable action-item store; these tools
 * let the agent read and curate it in-loop (tools-not-router), the same way it
 * manages the vault. Capture still happens automatically from turns/email/
 * meetings, but the agent can add, complete, snooze, and delegate explicitly.
 *
 * Tools:
 *   todo_list      — the ranked action list (optionally one direction)
 *   todo_add       — add an item (mine = I owe / theirs = someone owes me)
 *   todo_complete  — mark an item done
 *   todo_snooze    — push an item's deadline out
 *   todo_delegate  — hand an item off to a person or to yourself (the agent)
 */

import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";
import {
  addActionItem,
  completeCommitment,
  delegateCommitment,
  getActionItems,
  snoozeCommitment,
  type CommitmentRow,
} from "../proactive/commitment-tracker.ts";

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
const fail = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });

function fmt(c: CommitmentRow): string {
  const pri = c.priority ? `[${c.priority.toUpperCase()}] ` : "";
  const who = c.direction === "theirs" ? "waiting on someone" : "you owe";
  const due = c.deadline ? ` (due ${c.deadline.toISOString().slice(0, 10)})` : "";
  return `- ${pri}${c.description}${due} — ${who} · id=${c.id}`;
}

/** Build the per-user commitments (action-list) MCP server. */
export function buildCommitmentsMcpServer(userId: string): McpSdkServerConfigWithInstance {
  const todoList = tool(
    "todo_list",
    "List the action items on your plate: things the user owes ('mine') and things others owe the user ('theirs', the waiting-on lane). Returns them ranked (p0..p3 first, then by due date). Use before answering 'what's on my list' or when deciding what to follow up on.",
    {
      direction: z
        .enum(["mine", "theirs"])
        .optional()
        .describe("Filter: 'mine' = user owes, 'theirs' = someone owes the user. Omit for both."),
      limit: z.number().int().min(1).max(50).optional().describe("Max items (default 20)"),
    },
    async (args) => {
      try {
        const items = await getActionItems(userId, {
          direction: args.direction,
          limit: args.limit ?? 20,
        });
        if (items.length === 0) return ok("No open action items.");
        return ok(items.map(fmt).join("\n"));
      } catch (e) {
        return fail(`todo_list failed: ${e instanceof Error ? e.message : e}`);
      }
    },
    { annotations: { readOnlyHint: true } },
  );

  const todoAdd = tool(
    "todo_add",
    "Add an action item. Use direction 'mine' when the USER owes it, 'theirs' when someone owes the USER (so it lands in the waiting-on lane and gets polite follow-ups). Set sourceRef to the origin thread/message id when known so a follow-up can reply on the same thread.",
    {
      description: z.string().describe("What needs to happen (phrase it as the outstanding item)"),
      direction: z
        .enum(["mine", "theirs"])
        .optional()
        .describe("'mine' = user owes (default), 'theirs' = someone owes the user"),
      deadline: z.string().optional().describe("ISO date/time if there's a due date"),
      contact: z.string().optional().describe("The other party's name, if any"),
      source: z
        .string()
        .optional()
        .describe("Which surface this came from: email | slack | imessage | meeting | manual …"),
      sourceRef: z.string().optional().describe("Origin thread/message/event id for follow-ups"),
    },
    async (args) => {
      try {
        const deadline = args.deadline ? new Date(args.deadline) : null;
        const row = await addActionItem(userId, {
          description: args.description,
          direction: args.direction ?? "mine",
          deadline: deadline && !Number.isNaN(deadline.getTime()) ? deadline : null,
          contact: args.contact ?? null,
          source: args.source ?? "manual",
          sourceRef: args.sourceRef,
        });
        return ok(`Added (id=${row.id}).`);
      } catch (e) {
        return fail(`todo_add failed: ${e instanceof Error ? e.message : e}`);
      }
    },
  );

  const todoComplete = tool(
    "todo_complete",
    "Mark an action item done. Pass the id from todo_list.",
    { id: z.string().describe("The action item id") },
    async (args) => {
      try {
        await completeCommitment(userId, args.id);
        return ok("Marked done.");
      } catch (e) {
        return fail(`todo_complete failed: ${e instanceof Error ? e.message : e}`);
      }
    },
  );

  const todoSnooze = tool(
    "todo_snooze",
    "Push an action item's due date out (e.g. 'remind me next week'). Pass the id and a new ISO date/time.",
    {
      id: z.string().describe("The action item id"),
      until: z.string().describe("New ISO date/time for the item"),
    },
    async (args) => {
      try {
        const until = new Date(args.until);
        if (Number.isNaN(until.getTime())) return fail(`Not a valid date: ${args.until}`);
        await snoozeCommitment(userId, args.id, until);
        return ok(`Snoozed to ${until.toISOString().slice(0, 10)}.`);
      } catch (e) {
        return fail(`todo_snooze failed: ${e instanceof Error ? e.message : e}`);
      }
    },
  );

  const todoDelegate = tool(
    "todo_delegate",
    "Hand an action item off — to a person ('delegate to Monica') or to yourself, the agent ('you handle it'), using to='nomos'. Pass the id.",
    {
      id: z.string().describe("The action item id"),
      to: z.string().describe("Who it's delegated to (a name, or 'nomos' for yourself)"),
    },
    async (args) => {
      try {
        await delegateCommitment(userId, args.id, args.to);
        return ok(`Delegated to ${args.to}.`);
      } catch (e) {
        return fail(`todo_delegate failed: ${e instanceof Error ? e.message : e}`);
      }
    },
  );

  return createSdkMcpServer({
    name: "nomos-commitments",
    version: "1.0.0",
    // Always loaded so the action list is reachable every turn, not deferred.
    alwaysLoad: true,
    tools: [todoList, todoAdd, todoComplete, todoSnooze, todoDelegate],
  });
}
