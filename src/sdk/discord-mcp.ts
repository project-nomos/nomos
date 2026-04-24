/**
 * In-process MCP server that exposes Discord REST API tools to the agent.
 *
 * Uses discord.js REST client — no gateway connection needed.
 * Reads DISCORD_BOT_TOKEN from process.env at call time.
 *
 * Tools: send, edit, delete messages; read channel/thread history;
 *        react; list channels; member info; pin/unpin; create thread.
 */

import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";

/** Cached token loaded from DB (populated on first call). */
let cachedDiscordToken: string | null | undefined;

function getRest() {
  const { REST } = require("discord.js") as typeof import("discord.js");
  const token = cachedDiscordToken ?? process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    throw new Error("DISCORD_BOT_TOKEN is not set");
  }
  return new REST({ version: "10" }).setToken(token);
}

/**
 * Load Discord bot token from DB, cache it for sync getRest() calls.
 * Call once at startup from agent-runtime.
 */
export async function loadDiscordTokenFromDb(): Promise<void> {
  try {
    const { getSecretOrEnv } = await import("../db/integrations.ts");
    const token = await getSecretOrEnv("discord", "bot_token", "DISCORD_BOT_TOKEN");
    if (token) cachedDiscordToken = token;
  } catch {
    // DB not available
  }
}

/** Format a Discord message for display. */
function formatMessage(msg: Record<string, unknown>): string {
  const author = msg.author as Record<string, unknown> | undefined;
  const username = (author?.username as string) ?? "unknown";
  const content = (msg.content as string) ?? "";
  const id = (msg.id as string) ?? "";
  const ts = (msg.timestamp as string) ?? "";
  return `[${ts}] (${id}) <${username}> ${content}`;
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const sendMessageTool = tool(
  "discord_send_message",
  "Send a message to a Discord channel. Returns the message ID.",
  {
    channel_id: z.string().describe("Channel or thread ID (snowflake)"),
    content: z.string().describe("Message text (supports Discord markdown)"),
  },
  async (args) => {
    try {
      const rest = getRest();
      const result = (await rest.post(`/channels/${args.channel_id}/messages`, {
        body: { content: args.content },
      })) as Record<string, unknown>;
      return {
        content: [{ type: "text", text: `Message sent. id=${result.id}` }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Failed: ${(error as Error).message}` }],
        isError: true,
      };
    }
  },
);

const sendEmbedTool = tool(
  "discord_send_embed",
  "Send a rich embed message to a Discord channel.",
  {
    channel_id: z.string().describe("Channel ID"),
    content: z.string().optional().describe("Optional text content above the embed"),
    title: z.string().optional().describe("Embed title"),
    description: z.string().optional().describe("Embed description (supports markdown)"),
    color: z
      .number()
      .int()
      .optional()
      .describe("Embed color as decimal integer (e.g. 5763719 for green)"),
    footer: z.string().optional().describe("Footer text"),
  },
  async (args) => {
    try {
      const rest = getRest();
      const embed: Record<string, unknown> = {};
      if (args.title) embed.title = args.title;
      if (args.description) embed.description = args.description;
      if (args.color !== undefined) embed.color = args.color;
      if (args.footer) embed.footer = { text: args.footer };

      const body: Record<string, unknown> = { embeds: [embed] };
      if (args.content) body.content = args.content;

      const result = (await rest.post(`/channels/${args.channel_id}/messages`, {
        body,
      })) as Record<string, unknown>;
      return {
        content: [{ type: "text", text: `Embed sent. id=${result.id}` }],
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
  "discord_edit_message",
  "Edit an existing Discord message.",
  {
    channel_id: z.string().describe("Channel ID"),
    message_id: z.string().describe("Message ID to edit"),
    content: z.string().describe("New message content"),
  },
  async (args) => {
    try {
      const rest = getRest();
      await rest.patch(`/channels/${args.channel_id}/messages/${args.message_id}`, {
        body: { content: args.content },
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
  "discord_delete_message",
  "Delete a Discord message.",
  {
    channel_id: z.string().describe("Channel ID"),
    message_id: z.string().describe("Message ID to delete"),
  },
  async (args) => {
    try {
      const rest = getRest();
      await rest.delete(`/channels/${args.channel_id}/messages/${args.message_id}`);
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
  "discord_read_channel",
  "Read recent messages from a Discord channel or thread.",
  {
    channel_id: z.string().describe("Channel or thread ID"),
    limit: z.number().int().min(1).max(100).optional().describe("Number of messages (default 20)"),
  },
  async (args) => {
    try {
      const rest = getRest();
      const messages = (await rest.get(`/channels/${args.channel_id}/messages`, {
        query: new URLSearchParams({ limit: String(args.limit ?? 20) }),
      })) as Array<Record<string, unknown>>;

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

const reactTool = tool(
  "discord_react",
  "Add a reaction to a Discord message. Use URL-encoded emoji for custom, or Unicode emoji directly.",
  {
    channel_id: z.string().describe("Channel ID"),
    message_id: z.string().describe("Message ID"),
    emoji: z.string().describe("Emoji: Unicode char (e.g. \\u2705) or custom format name:id"),
  },
  async (args) => {
    try {
      const rest = getRest();
      const encoded = encodeURIComponent(args.emoji);
      await rest.put(
        `/channels/${args.channel_id}/messages/${args.message_id}/reactions/${encoded}/@me`,
      );
      return { content: [{ type: "text", text: `Reacted with ${args.emoji}` }] };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Failed: ${(error as Error).message}` }],
        isError: true,
      };
    }
  },
);

const pinMessageTool = tool(
  "discord_pin_message",
  "Pin a message in a Discord channel.",
  {
    channel_id: z.string().describe("Channel ID"),
    message_id: z.string().describe("Message ID to pin"),
  },
  async (args) => {
    try {
      const rest = getRest();
      await rest.put(`/channels/${args.channel_id}/pins/${args.message_id}`);
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
  "discord_unpin_message",
  "Unpin a message in a Discord channel.",
  {
    channel_id: z.string().describe("Channel ID"),
    message_id: z.string().describe("Message ID to unpin"),
  },
  async (args) => {
    try {
      const rest = getRest();
      await rest.delete(`/channels/${args.channel_id}/pins/${args.message_id}`);
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
  "discord_list_pins",
  "List pinned messages in a Discord channel.",
  {
    channel_id: z.string().describe("Channel ID"),
  },
  async (args) => {
    try {
      const rest = getRest();
      const messages = (await rest.get(`/channels/${args.channel_id}/pins`)) as Array<
        Record<string, unknown>
      >;

      if (messages.length === 0) {
        return { content: [{ type: "text", text: "No pinned messages." }] };
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

const createThreadTool = tool(
  "discord_create_thread",
  "Create a new thread in a Discord channel. Can start from a message or as a standalone thread.",
  {
    channel_id: z.string().describe("Channel ID to create the thread in"),
    name: z.string().describe("Thread name"),
    message_id: z
      .string()
      .optional()
      .describe("Message ID to start the thread from (omit for standalone thread)"),
    auto_archive_duration: z
      .number()
      .int()
      .optional()
      .describe("Minutes before auto-archive: 60, 1440, 4320, or 10080 (default 1440)"),
  },
  async (args) => {
    try {
      const rest = getRest();
      let result: Record<string, unknown>;

      if (args.message_id) {
        // Thread from a message
        result = (await rest.post(
          `/channels/${args.channel_id}/messages/${args.message_id}/threads`,
          {
            body: {
              name: args.name,
              auto_archive_duration: args.auto_archive_duration ?? 1440,
            },
          },
        )) as Record<string, unknown>;
      } else {
        // Standalone public thread
        result = (await rest.post(`/channels/${args.channel_id}/threads`, {
          body: {
            name: args.name,
            type: 11, // PUBLIC_THREAD
            auto_archive_duration: args.auto_archive_duration ?? 1440,
          },
        })) as Record<string, unknown>;
      }
      return {
        content: [
          {
            type: "text",
            text: `Thread created. id=${result.id}, name=${result.name}`,
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

const listChannelsTool = tool(
  "discord_list_channels",
  "List channels in a Discord server (guild).",
  {
    guild_id: z.string().describe("Guild (server) ID"),
  },
  async (args) => {
    try {
      const rest = getRest();
      const channels = (await rest.get(`/guilds/${args.guild_id}/channels`)) as Array<
        Record<string, unknown>
      >;

      if (channels.length === 0) {
        return { content: [{ type: "text", text: "No channels found." }] };
      }

      const typeNames: Record<number, string> = {
        0: "text",
        2: "voice",
        4: "category",
        5: "announcement",
        10: "news-thread",
        11: "public-thread",
        12: "private-thread",
        13: "stage",
        15: "forum",
        16: "media",
      };

      const formatted = channels
        .map((ch) => {
          const type = typeNames[(ch.type as number) ?? 0] ?? `type-${ch.type}`;
          return `${ch.id}  #${ch.name} (${type})`;
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

const memberInfoTool = tool(
  "discord_member_info",
  "Get information about a Discord guild member.",
  {
    guild_id: z.string().describe("Guild (server) ID"),
    user_id: z.string().describe("User ID"),
  },
  async (args) => {
    try {
      const rest = getRest();
      const member = (await rest.get(`/guilds/${args.guild_id}/members/${args.user_id}`)) as Record<
        string,
        unknown
      >;

      const user = member.user as Record<string, unknown> | undefined;
      const info = [
        `Username: ${user?.username ?? "—"}`,
        `Display name: ${user?.global_name ?? "—"}`,
        `Nickname: ${(member.nick as string) ?? "—"}`,
        `User ID: ${user?.id ?? "—"}`,
        `Joined: ${(member.joined_at as string) ?? "—"}`,
        `Roles: ${((member.roles as string[]) ?? []).join(", ") || "none"}`,
        `Is bot: ${user?.bot ?? false}`,
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

const searchMessagesTool = tool(
  "discord_search",
  "Search messages in a Discord guild. Supports content, author, channel filters.",
  {
    guild_id: z.string().describe("Guild (server) ID"),
    content: z.string().optional().describe("Search by message content"),
    author_id: z.string().optional().describe("Filter by author user ID"),
    channel_id: z.string().optional().describe("Filter by channel ID"),
    limit: z.number().int().min(1).max(25).optional().describe("Max results (default 10)"),
  },
  async (args) => {
    try {
      const rest = getRest();
      const params = new URLSearchParams();
      if (args.content) params.set("content", args.content);
      if (args.author_id) params.set("author_id", args.author_id);
      if (args.channel_id) params.set("channel_id", args.channel_id);
      params.set("limit", String(args.limit ?? 10));

      const result = (await rest.get(`/guilds/${args.guild_id}/messages/search`, {
        query: params,
      })) as { messages?: Array<Array<Record<string, unknown>>> };

      const matches = result.messages ?? [];
      if (matches.length === 0) {
        return { content: [{ type: "text", text: "No results found." }] };
      }

      const formatted = matches
        .map((group) => {
          const msg = group[0];
          if (!msg) return "";
          return formatMessage(msg);
        })
        .filter(Boolean)
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

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function isDiscordConfigured(): boolean {
  return Boolean(process.env.DISCORD_BOT_TOKEN);
}

export function createDiscordMcpServer(): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: "nomos-discord",
    version: "0.1.0",
    tools: [
      sendMessageTool,
      sendEmbedTool,
      editMessageTool,
      deleteMessageTool,
      readChannelTool,
      reactTool,
      pinMessageTool,
      unpinMessageTool,
      listPinsTool,
      createThreadTool,
      listChannelsTool,
      memberInfoTool,
      searchMessagesTool,
    ],
  });
}
