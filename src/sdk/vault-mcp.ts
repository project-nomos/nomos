/**
 * In-process MCP server exposing the agent's long-term MEMORY as tools (the
 * memory-tool pattern with our own Postgres-backed vault). Built per turn, scoped
 * to the requesting user, and injected in both power-user and hosted modes.
 *
 * Tools:
 *   memory_read   — read a note by path
 *   memory_write  — write/revise a note (revise, do not append)
 *   memory_list   — list notes (optional path prefix)
 *   memory_forget — delete a note ("forget this")
 *   load_thread   — list recent conversations, or load one full transcript
 *
 * Semantic recall at scale stays in `memory_search` (vector); relational recall
 * in `graph_search` (kg). These are the everyday read/write of the vault.
 */

import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";
import { getKysely } from "../db/client.ts";
import { vaultDelete, vaultList, vaultRead, vaultWrite } from "../memory/vault.ts";

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
const fail = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });

/** Build the per-user vault MCP server. */
export function buildVaultMcpServer(userId: string): McpSdkServerConfigWithInstance {
  const memoryRead = tool(
    "memory_read",
    "Read one note from your long-term memory by its path (e.g. 'people/dana.md', 'profile.md'). Returns the note's markdown, or says it does not exist.",
    { path: z.string().describe("The note path") },
    async (args) => {
      try {
        const note = await vaultRead(userId, args.path);
        if (!note) return ok(`No note at "${args.path}".`);
        return ok(
          `# ${note.title}\n(${note.path}, updated ${note.updatedAt.toISOString().slice(0, 10)})\n\n${note.content}`,
        );
      } catch (e) {
        return fail(`memory_read failed: ${e instanceof Error ? e.message : e}`);
      }
    },
    { annotations: { readOnlyHint: true } },
  );

  const memoryWrite = tool(
    "memory_write",
    "Write or REVISE a note in your long-term memory (upsert by path). Use this to remember durable facts about the user, decisions, and per-topic notes. Revise the existing note rather than piling on duplicates or contradictions. Link related notes with [[wikilinks]]. When the user states a GOAL (something they're working toward), record it under a 'goals/<slug>.md' path so it becomes a first-class goal the weekly review can track.",
    {
      path: z.string().describe("The note path, e.g. 'people/dana.md' or 'profile.md'"),
      content: z
        .string()
        .describe("The full markdown content of the note (replaces the previous body)"),
      title: z.string().optional().describe("Optional human title; defaults to the file name"),
    },
    async (args) => {
      try {
        const note = await vaultWrite(userId, args.path, args.content, { title: args.title });
        return ok(`Saved "${note.path}".`);
      } catch (e) {
        return fail(`memory_write failed: ${e instanceof Error ? e.message : e}`);
      }
    },
  );

  const memoryList = tool(
    "memory_list",
    "List your memory notes, optionally filtered to a path prefix (e.g. 'people/'). Returns paths + titles so you can decide what to read.",
    { prefix: z.string().optional().describe("Optional path prefix filter") },
    async (args) => {
      try {
        const notes = await vaultList(userId, args.prefix);
        if (notes.length === 0) return ok("No memory notes yet.");
        return ok(notes.map((n) => `- ${n.path} — ${n.title}`).join("\n"));
      } catch (e) {
        return fail(`memory_list failed: ${e instanceof Error ? e.message : e}`);
      }
    },
    { annotations: { readOnlyHint: true } },
  );

  const memoryForget = tool(
    "memory_forget",
    "Delete a note from your long-term memory by path. Use when the user asks you to forget something, or a note is wrong and superseded.",
    { path: z.string().describe("The note path to delete") },
    async (args) => {
      try {
        await vaultDelete(userId, args.path);
        return ok(`Forgot "${args.path}".`);
      } catch (e) {
        return fail(`memory_forget failed: ${e instanceof Error ? e.message : e}`);
      }
    },
  );

  const loadThread = tool(
    "load_thread",
    "Load the exact back-and-forth of a past conversation. Call with no arguments to list your recent conversations (with their keys); call with a thread key to load that conversation's transcript. Use when you need precise wording, who said what, a number, beyond what your memory notes hold.",
    {
      thread: z
        .string()
        .optional()
        .describe("The conversation key to load; omit to list recent conversations"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("Max messages to load (default 30)"),
    },
    async (args) => {
      try {
        const db = getKysely();
        if (!args.thread) {
          const rows = await db
            .selectFrom("sessions")
            .select(["session_key", "updated_at"])
            .where("user_id", "=", userId)
            .orderBy("updated_at", "desc")
            .limit(15)
            .execute();
          if (rows.length === 0) return ok("No past conversations.");
          return ok(
            "Recent conversations (load one with load_thread thread=<key>):\n" +
              rows
                .map(
                  (r) =>
                    `- ${r.session_key} (last active ${r.updated_at.toISOString().slice(0, 10)})`,
                )
                .join("\n"),
          );
        }
        const session = await db
          .selectFrom("sessions")
          .select("id")
          .where("session_key", "=", args.thread)
          .where("user_id", "=", userId)
          .executeTakeFirst();
        if (!session) return ok(`No conversation with key "${args.thread}".`);
        const msgs = await db
          .selectFrom("transcript_messages")
          .select(["role", "content", "created_at"])
          .where("session_id", "=", session.id)
          .orderBy("id", "desc")
          .limit(args.limit ?? 30)
          .execute();
        if (msgs.length === 0) return ok(`Conversation "${args.thread}" has no messages.`);
        const text = msgs
          .reverse()
          .map((m) => {
            const body = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
            return `[${m.role}] ${body}`;
          })
          .join("\n");
        return ok(`Transcript of "${args.thread}":\n\n${text}`);
      } catch (e) {
        return fail(`load_thread failed: ${e instanceof Error ? e.message : e}`);
      }
    },
    { annotations: { readOnlyHint: true } },
  );

  return createSdkMcpServer({
    name: "nomos-vault",
    version: "1.0.0",
    // Always loaded so durable memory read/write is reachable every turn, not deferred.
    alwaysLoad: true,
    tools: [memoryRead, memoryWrite, memoryList, memoryForget, loadThread],
  });
}
