/**
 * In-process MCP server that exposes Telegram Bot API tools to the agent.
 *
 * Uses grammY's standalone Api class — no bot polling needed.
 * Reads TELEGRAM_BOT_TOKEN from process.env at call time.
 *
 * Tools: send, edit, delete messages; get updates; send photos/documents/location;
 *        chat info; member info; typing indicator.
 */

import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";

/** Cached token loaded from DB (populated on first call). */
let cachedTelegramToken: string | null | undefined;

function getApi() {
  const { Api } = require("grammy") as typeof import("grammy");
  const token = cachedTelegramToken ?? process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN is not set");
  }
  return new Api(token);
}

/**
 * Load Telegram bot token from DB, cache it for sync getApi() calls.
 * Call once at startup from agent-runtime.
 */
export async function loadTelegramTokenFromDb(): Promise<void> {
  try {
    const { getSecretOrEnv } = await import("../db/integrations.ts");
    const token = await getSecretOrEnv("telegram", "bot_token", "TELEGRAM_BOT_TOKEN");
    if (token) cachedTelegramToken = token;
  } catch {
    // DB not available
  }
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const sendMessageTool = tool(
  "telegram_send_message",
  "Send a text message to a Telegram chat. Returns the message ID.",
  {
    chat_id: z.string().describe("Chat ID (positive for users, negative for groups/channels)"),
    text: z.string().describe("Message text"),
    parse_mode: z.enum(["Markdown", "HTML"]).optional().describe("Formatting mode (default: none)"),
    reply_to_message_id: z.number().int().optional().describe("Message ID to reply to"),
  },
  async (args) => {
    try {
      const api = getApi();
      const result = await api.sendMessage(Number(args.chat_id), args.text, {
        parse_mode: args.parse_mode,
        reply_parameters: args.reply_to_message_id
          ? { message_id: args.reply_to_message_id }
          : undefined,
      });
      return {
        content: [
          {
            type: "text",
            text: `Message sent. message_id=${result.message_id}, chat_id=${result.chat.id}`,
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
  "telegram_edit_message",
  "Edit an existing Telegram message.",
  {
    chat_id: z.string().describe("Chat ID"),
    message_id: z.number().int().describe("Message ID to edit"),
    text: z.string().describe("New message text"),
    parse_mode: z.enum(["Markdown", "HTML"]).optional().describe("Formatting mode"),
  },
  async (args) => {
    try {
      const api = getApi();
      await api.editMessageText(Number(args.chat_id), args.message_id, args.text, {
        parse_mode: args.parse_mode,
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
  "telegram_delete_message",
  "Delete a Telegram message.",
  {
    chat_id: z.string().describe("Chat ID"),
    message_id: z.number().int().describe("Message ID to delete"),
  },
  async (args) => {
    try {
      const api = getApi();
      await api.deleteMessage(Number(args.chat_id), args.message_id);
      return { content: [{ type: "text", text: "Message deleted." }] };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Failed: ${(error as Error).message}` }],
        isError: true,
      };
    }
  },
);

const sendPhotoTool = tool(
  "telegram_send_photo",
  "Send a photo to a Telegram chat. Provide a URL or local file path.",
  {
    chat_id: z.string().describe("Chat ID"),
    photo: z.string().describe("Photo URL or absolute file path"),
    caption: z.string().optional().describe("Photo caption (max 1024 chars)"),
    parse_mode: z.enum(["Markdown", "HTML"]).optional().describe("Caption formatting mode"),
  },
  async (args) => {
    try {
      const api = getApi();
      let photoInput: Parameters<typeof api.sendPhoto>[1];

      if (args.photo.startsWith("/")) {
        // Local file
        const fs = await import("node:fs");
        if (!fs.existsSync(args.photo)) {
          return {
            content: [{ type: "text", text: `File not found: ${args.photo}` }],
            isError: true,
          };
        }
        const { InputFile } = require("grammy") as typeof import("grammy");
        photoInput = new InputFile(args.photo);
      } else {
        photoInput = args.photo;
      }

      const result = await api.sendPhoto(Number(args.chat_id), photoInput, {
        caption: args.caption,
        parse_mode: args.parse_mode,
      });
      return {
        content: [{ type: "text", text: `Photo sent. message_id=${result.message_id}` }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Failed: ${(error as Error).message}` }],
        isError: true,
      };
    }
  },
);

const sendDocumentTool = tool(
  "telegram_send_document",
  "Send a document/file to a Telegram chat.",
  {
    chat_id: z.string().describe("Chat ID"),
    document: z.string().describe("Document URL or absolute file path"),
    caption: z.string().optional().describe("Document caption"),
  },
  async (args) => {
    try {
      const api = getApi();
      let docInput: Parameters<typeof api.sendDocument>[1];

      if (args.document.startsWith("/")) {
        const fs = await import("node:fs");
        if (!fs.existsSync(args.document)) {
          return {
            content: [{ type: "text", text: `File not found: ${args.document}` }],
            isError: true,
          };
        }
        const { InputFile } = require("grammy") as typeof import("grammy");
        docInput = new InputFile(args.document);
      } else {
        docInput = args.document;
      }

      const result = await api.sendDocument(Number(args.chat_id), docInput, {
        caption: args.caption,
      });
      return {
        content: [{ type: "text", text: `Document sent. message_id=${result.message_id}` }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Failed: ${(error as Error).message}` }],
        isError: true,
      };
    }
  },
);

const sendLocationTool = tool(
  "telegram_send_location",
  "Send a location to a Telegram chat.",
  {
    chat_id: z.string().describe("Chat ID"),
    latitude: z.number().describe("Latitude"),
    longitude: z.number().describe("Longitude"),
  },
  async (args) => {
    try {
      const api = getApi();
      const result = await api.sendLocation(Number(args.chat_id), args.latitude, args.longitude);
      return {
        content: [{ type: "text", text: `Location sent. message_id=${result.message_id}` }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Failed: ${(error as Error).message}` }],
        isError: true,
      };
    }
  },
);

const chatInfoTool = tool(
  "telegram_chat_info",
  "Get information about a Telegram chat.",
  {
    chat_id: z.string().describe("Chat ID"),
  },
  async (args) => {
    try {
      const api = getApi();
      const chat = await api.getChat(Number(args.chat_id));
      const info = [
        `ID: ${chat.id}`,
        `Type: ${chat.type}`,
        `Title: ${"title" in chat ? chat.title : "—"}`,
        `Username: ${"username" in chat ? `@${chat.username}` : "—"}`,
        `First name: ${"first_name" in chat ? chat.first_name : "—"}`,
        `Description: ${"description" in chat ? chat.description : "—"}`,
      ].join("\n");
      return { content: [{ type: "text", text: info }] };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Failed: ${(error as Error).message}` }],
        isError: true,
      };
    }
  },
  { annotations: { readOnly: true } },
);

const chatMemberTool = tool(
  "telegram_member_info",
  "Get information about a member in a Telegram chat.",
  {
    chat_id: z.string().describe("Chat ID"),
    user_id: z.number().int().describe("User ID"),
  },
  async (args) => {
    try {
      const api = getApi();
      const member = await api.getChatMember(Number(args.chat_id), args.user_id);
      const user = member.user;
      const info = [
        `User ID: ${user.id}`,
        `Username: ${user.username ? `@${user.username}` : "—"}`,
        `First name: ${user.first_name}`,
        `Last name: ${user.last_name ?? "—"}`,
        `Status: ${member.status}`,
        `Is bot: ${user.is_bot}`,
      ].join("\n");
      return { content: [{ type: "text", text: info }] };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Failed: ${(error as Error).message}` }],
        isError: true,
      };
    }
  },
  { annotations: { readOnly: true } },
);

const sendTypingTool = tool(
  "telegram_send_typing",
  "Send a typing indicator to a Telegram chat. Useful before long operations.",
  {
    chat_id: z.string().describe("Chat ID"),
  },
  async (args) => {
    try {
      const api = getApi();
      await api.sendChatAction(Number(args.chat_id), "typing");
      return { content: [{ type: "text", text: "Typing indicator sent." }] };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Failed: ${(error as Error).message}` }],
        isError: true,
      };
    }
  },
);

const botInfoTool = tool(
  "telegram_bot_info",
  "Get information about the Telegram bot itself.",
  {},
  async () => {
    try {
      const api = getApi();
      const me = await api.getMe();
      const info = [
        `Bot ID: ${me.id}`,
        `Username: @${me.username}`,
        `First name: ${me.first_name}`,
        `Can join groups: ${me.can_join_groups ?? "—"}`,
        `Can read group messages: ${me.can_read_all_group_messages ?? "—"}`,
        `Supports inline: ${me.supports_inline_queries ?? false}`,
      ].join("\n");
      return { content: [{ type: "text", text: info }] };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Failed: ${(error as Error).message}` }],
        isError: true,
      };
    }
  },
  { annotations: { readOnly: true } },
);

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function isTelegramConfigured(): boolean {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN);
}

export function createTelegramMcpServer(): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: "nomos-telegram",
    version: "0.1.0",
    tools: [
      sendMessageTool,
      editMessageTool,
      deleteMessageTool,
      sendPhotoTool,
      sendDocumentTool,
      sendLocationTool,
      chatInfoTool,
      chatMemberTool,
      sendTypingTool,
      botInfoTool,
    ],
  });
}
