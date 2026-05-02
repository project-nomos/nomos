/**
 * In-process MCP server that exposes Slack Web API tools to the agent.
 *
 * Token resolution order:
 *   1. User token from DB (slack_user_tokens table) — acts as the user
 *   2. SLACK_USER_TOKEN env var — single-workspace user mode fallback
 *   3. SLACK_BOT_TOKEN env var — bot mode fallback
 *
 * Tools: send, edit, delete messages; read channel/thread history;
 *        react; list channels; user info; pin/unpin; upload file; search.
 */

import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";

/** Cached user token loaded from DB (populated on first call). */
let cachedUserToken: string | null | undefined;

async function loadUserTokenFromDb(): Promise<string | null> {
  try {
    const { listWorkspaces } = await import("../db/slack-workspaces.ts");
    const workspaces = await listWorkspaces();
    if (workspaces.length > 0) {
      return workspaces[0].access_token;
    }
  } catch {
    // DB not available — fall through
  }
  return null;
}

async function getClientAsync() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { WebClient } = require("@slack/web-api") as typeof import("@slack/web-api");

  // Try user token from DB (cached after first lookup)
  if (cachedUserToken === undefined) {
    cachedUserToken = await loadUserTokenFromDb();
  }
  if (cachedUserToken) {
    return new WebClient(cachedUserToken);
  }

  // Try integration DB for bot/user token
  try {
    const { getSecretOrEnv } = await import("../db/integrations.ts");
    const botToken = await getSecretOrEnv("slack", "bot_token", "SLACK_BOT_TOKEN");
    if (botToken) return new WebClient(botToken);
    const userToken = await getSecretOrEnv("slack", "user_token", "SLACK_USER_TOKEN");
    if (userToken) return new WebClient(userToken);
  } catch {
    // DB not available — fall through to env
  }

  // Fallback: SLACK_USER_TOKEN env var
  if (process.env.SLACK_USER_TOKEN) {
    return new WebClient(process.env.SLACK_USER_TOKEN);
  }

  // Fallback: SLACK_BOT_TOKEN env var
  const botToken = process.env.SLACK_BOT_TOKEN;
  if (botToken) {
    return new WebClient(botToken);
  }

  throw new Error("No Slack token available (checked DB, SLACK_USER_TOKEN, SLACK_BOT_TOKEN)");
}

/** Format a Slack message for display. */
function formatMessage(msg: Record<string, unknown>): string {
  const user = (msg.user as string) ?? "unknown";
  const text = (msg.text as string) ?? "";
  const ts = (msg.ts as string) ?? "";
  const reactions = msg.reactions as Array<{ name: string; count: number }> | undefined;

  let line = `[${ts}] <${user}> ${text}`;
  if (reactions?.length) {
    const rxns = reactions.map((r) => `:${r.name}: (${r.count})`).join(" ");
    line += `  ${rxns}`;
  }
  return line;
}

// ---------------------------------------------------------------------------
// Reusable tool factory
// ---------------------------------------------------------------------------

/**
 * Create the Slack tool definitions bound to a specific client factory.
 * This allows per-workspace MCP servers to reuse the same tool logic
 * with different tokens.
 *
 * @param getClient - async factory that returns a Slack WebClient instance
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createSlackTools(getClient: () => Promise<any>) {
  const sendMessageTool = tool(
    "slack_send_message",
    "Send a message to a Slack channel or thread. Returns the timestamp of the sent message.",
    {
      channel: z.string().describe("Channel ID (e.g. C01ABCDEF)"),
      text: z.string().describe("Message text (supports Slack mrkdwn formatting)"),
      thread_ts: z.string().optional().describe("Thread timestamp to reply in a thread"),
    },
    async (args) => {
      try {
        const client = await getClient();
        const result = await client.chat.postMessage({
          channel: args.channel,
          text: args.text,
          thread_ts: args.thread_ts,
        });
        return {
          content: [
            {
              type: "text",
              text: `Message sent. ts=${result.ts}, channel=${result.channel}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Failed: ${(error as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  const editMessageTool = tool(
    "slack_edit_message",
    "Edit an existing Slack message.",
    {
      channel: z.string().describe("Channel ID"),
      ts: z.string().describe("Timestamp of the message to edit"),
      text: z.string().describe("New message text"),
    },
    async (args) => {
      try {
        const client = await getClient();
        await client.chat.update({
          channel: args.channel,
          ts: args.ts,
          text: args.text,
        });
        return { content: [{ type: "text", text: "Message updated." }] };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Failed: ${(error as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  const deleteMessageTool = tool(
    "slack_delete_message",
    "Delete a Slack message.",
    {
      channel: z.string().describe("Channel ID"),
      ts: z.string().describe("Timestamp of the message to delete"),
    },
    async (args) => {
      try {
        const client = await getClient();
        await client.chat.delete({ channel: args.channel, ts: args.ts });
        return { content: [{ type: "text", text: "Message deleted." }] };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Failed: ${(error as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  const readChannelTool = tool(
    "slack_read_channel",
    "Read recent messages from a Slack channel.",
    {
      channel: z.string().describe("Channel ID"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("Number of messages (default 20)"),
    },
    async (args) => {
      try {
        const client = await getClient();
        const result = await client.conversations.history({
          channel: args.channel,
          limit: args.limit ?? 20,
        });
        const messages = (result.messages ?? []) as Array<Record<string, unknown>>;
        if (messages.length === 0) {
          return { content: [{ type: "text", text: "No messages found." }] };
        }
        const formatted = messages.reverse().map(formatMessage).join("\n");
        return { content: [{ type: "text", text: formatted }] };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Failed: ${(error as Error).message}` }],
          isError: true,
        };
      }
    },
    { annotations: { readOnlyHint: true } },
  );

  const readThreadTool = tool(
    "slack_read_thread",
    "Read replies in a Slack thread.",
    {
      channel: z.string().describe("Channel ID"),
      thread_ts: z.string().describe("Thread parent timestamp"),
      limit: z.number().int().min(1).max(100).optional().describe("Number of replies (default 20)"),
    },
    async (args) => {
      try {
        const client = await getClient();
        const result = await client.conversations.replies({
          channel: args.channel,
          ts: args.thread_ts,
          limit: args.limit ?? 20,
        });
        const messages = (result.messages ?? []) as Array<Record<string, unknown>>;
        if (messages.length === 0) {
          return { content: [{ type: "text", text: "No replies found." }] };
        }
        const formatted = messages.map(formatMessage).join("\n");
        return { content: [{ type: "text", text: formatted }] };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Failed: ${(error as Error).message}` }],
          isError: true,
        };
      }
    },
    { annotations: { readOnlyHint: true } },
  );

  const reactTool = tool(
    "slack_react",
    "Add a reaction emoji to a Slack message.",
    {
      channel: z.string().describe("Channel ID"),
      timestamp: z.string().describe("Message timestamp"),
      name: z.string().describe("Emoji name without colons (e.g. thumbsup, heart, rocket)"),
    },
    async (args) => {
      try {
        const client = await getClient();
        await client.reactions.add({
          channel: args.channel,
          timestamp: args.timestamp,
          name: args.name,
        });
        return { content: [{ type: "text", text: `Reacted with :${args.name}:` }] };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Failed: ${(error as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  const listChannelsTool = tool(
    "slack_list_channels",
    "List Slack channels the bot has access to.",
    {
      types: z
        .string()
        .optional()
        .describe(
          "Channel types: public_channel, private_channel, mpim, im (comma-separated, default public_channel)",
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe("Max channels to return (default 100)"),
    },
    async (args) => {
      try {
        const client = await getClient();
        const result = await client.conversations.list({
          types: args.types ?? "public_channel",
          limit: args.limit ?? 100,
          exclude_archived: true,
        });
        const channels = result.channels ?? [];
        if (channels.length === 0) {
          return { content: [{ type: "text", text: "No channels found." }] };
        }
        const formatted = channels
          .map((ch: Record<string, unknown>) => {
            const purpose = (ch.purpose as { value?: string })?.value ?? "";
            const desc = purpose ? ` — ${purpose.slice(0, 80)}` : "";
            return `${ch.id}  #${ch.name}${desc}`;
          })
          .join("\n");
        return { content: [{ type: "text", text: formatted }] };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Failed: ${(error as Error).message}` }],
          isError: true,
        };
      }
    },
    { annotations: { readOnlyHint: true } },
  );

  const userInfoTool = tool(
    "slack_user_info",
    "Get information about a Slack user.",
    {
      user: z.string().describe("User ID (e.g. U01ABCDEF)"),
    },
    async (args) => {
      try {
        const client = await getClient();
        const result = await client.users.info({ user: args.user });
        const u = result.user;
        if (!u) {
          return { content: [{ type: "text", text: "User not found." }] };
        }
        const info = [
          `ID: ${u.id}`,
          `Name: ${u.name}`,
          `Real name: ${u.real_name ?? "—"}`,
          `Display name: ${u.profile?.display_name ?? "—"}`,
          `Email: ${u.profile?.email ?? "—"}`,
          `Title: ${u.profile?.title ?? "—"}`,
          `Status: ${u.profile?.status_emoji ?? ""} ${u.profile?.status_text ?? ""}`.trim(),
          `Timezone: ${u.tz ?? "—"}`,
          `Is admin: ${u.is_admin ?? false}`,
          `Is bot: ${u.is_bot ?? false}`,
        ].join("\n");
        return { content: [{ type: "text", text: info }] };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Failed: ${(error as Error).message}` }],
          isError: true,
        };
      }
    },
    { annotations: { readOnlyHint: true } },
  );

  const pinMessageTool = tool(
    "slack_pin_message",
    "Pin a message in a Slack channel.",
    {
      channel: z.string().describe("Channel ID"),
      timestamp: z.string().describe("Message timestamp to pin"),
    },
    async (args) => {
      try {
        const client = await getClient();
        await client.pins.add({ channel: args.channel, timestamp: args.timestamp });
        return { content: [{ type: "text", text: "Message pinned." }] };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Failed: ${(error as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  const unpinMessageTool = tool(
    "slack_unpin_message",
    "Unpin a message in a Slack channel.",
    {
      channel: z.string().describe("Channel ID"),
      timestamp: z.string().describe("Message timestamp to unpin"),
    },
    async (args) => {
      try {
        const client = await getClient();
        await client.pins.remove({ channel: args.channel, timestamp: args.timestamp });
        return { content: [{ type: "text", text: "Message unpinned." }] };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Failed: ${(error as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  const listPinsTool = tool(
    "slack_list_pins",
    "List pinned items in a Slack channel.",
    {
      channel: z.string().describe("Channel ID"),
    },
    async (args) => {
      try {
        const client = await getClient();
        const result = await client.pins.list({ channel: args.channel });
        const items = result.items ?? [];
        if (items.length === 0) {
          return { content: [{ type: "text", text: "No pinned items." }] };
        }
        const formatted = items
          .map((item: Record<string, unknown>) => {
            const pinned = item as Record<string, unknown>;
            const msg = pinned.message as Record<string, unknown> | undefined;
            if (!msg) return `(pinned item, type: ${pinned.type})`;
            return `[${msg.ts}] <${msg.user}> ${(msg.text as string)?.slice(0, 120) ?? ""}`;
          })
          .join("\n");
        return { content: [{ type: "text", text: formatted }] };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Failed: ${(error as Error).message}` }],
          isError: true,
        };
      }
    },
    { annotations: { readOnlyHint: true } },
  );

  const searchMessagesTool = tool(
    "slack_search",
    "Search Slack messages by keyword. Requires the search:read scope.",
    {
      query: z
        .string()
        .describe("Search query (supports Slack search syntax: in:#channel, from:@user, etc.)"),
      count: z.number().int().min(1).max(50).optional().describe("Number of results (default 10)"),
    },
    async (args) => {
      try {
        const client = await getClient();
        const result = await client.search.messages({
          query: args.query,
          count: args.count ?? 10,
          sort: "timestamp",
          sort_dir: "desc",
        });
        const matches = result.messages?.matches ?? [];
        if (matches.length === 0) {
          return { content: [{ type: "text", text: "No results found." }] };
        }
        const formatted = matches
          .map((m: Record<string, unknown>) => {
            const ch = (m.channel as { name?: string })?.name ?? "?";
            return `[${m.ts}] #${ch} <${m.user ?? m.username}> ${((m.text as string) ?? "").slice(0, 200)}`;
          })
          .join("\n\n");
        return { content: [{ type: "text", text: formatted }] };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Failed: ${(error as Error).message}` }],
          isError: true,
        };
      }
    },
    { annotations: { readOnlyHint: true } },
  );

  const uploadFileTool = tool(
    "slack_upload_file",
    "Upload a file to a Slack channel. The file must exist on the local filesystem.",
    {
      channel: z.string().describe("Channel ID to upload to"),
      file_path: z.string().describe("Absolute path to the file on disk"),
      title: z.string().optional().describe("File title"),
      initial_comment: z.string().optional().describe("Message text posted with the file"),
    },
    async (args) => {
      try {
        const fs = await import("node:fs");
        if (!fs.existsSync(args.file_path)) {
          return {
            content: [{ type: "text", text: `File not found: ${args.file_path}` }],
            isError: true,
          };
        }
        const client = await getClient();
        const fileStream = fs.createReadStream(args.file_path);
        const filename = args.file_path.split("/").pop() ?? "file";
        await client.filesUploadV2({
          channel_id: args.channel,
          file: fileStream,
          filename,
          title: args.title ?? filename,
          initial_comment: args.initial_comment,
        });
        return { content: [{ type: "text", text: `File uploaded: ${filename}` }] };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Failed: ${(error as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  return [
    sendMessageTool,
    editMessageTool,
    deleteMessageTool,
    readChannelTool,
    readThreadTool,
    reactTool,
    listChannelsTool,
    userInfoTool,
    pinMessageTool,
    unpinMessageTool,
    listPinsTool,
    searchMessagesTool,
    uploadFileTool,
  ];
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Returns true if any Slack token is available (user token in DB, env vars).
 * Call this before creating the MCP server to decide whether to register it.
 */
export function isSlackConfigured(): boolean {
  return Boolean(process.env.SLACK_BOT_TOKEN || process.env.SLACK_USER_TOKEN);
}

/**
 * Create the in-process Slack MCP server.
 * The server reads SLACK_BOT_TOKEN from process.env at call time.
 */
export function createSlackMcpServer(): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: "nomos-slack",
    version: "0.1.0",
    tools: createSlackTools(getClientAsync),
  });
}
