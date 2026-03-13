/**
 * CLI command for sending proactive messages to users/channels.
 *
 * Supports Discord, Slack, Telegram, and WhatsApp platforms.
 *
 * Usage examples:
 *   npx tsx src/cli/send.ts --platform slack --to C12345 --message "Hello from CLI"
 *   npx tsx src/cli/send.ts --platform discord --to 123456789 --raw --message "Hello"
 *   echo "Multi-line message" | npx tsx src/cli/send.ts --platform telegram --to 123456789
 *   npx tsx src/cli/send.ts --platform whatsapp --to 1234567890@s.whatsapp.net --agent --message "Compose a greeting"
 */

import process from "node:process";
import { runSession } from "../sdk/session.ts";
import { createMemoryMcpServer } from "../sdk/tools.ts";
import { loadEnvConfig } from "../config/env.ts";
import { loadAgentIdentity, loadUserProfile, buildSystemPromptAppend } from "../config/profile.ts";
import { loadSoulFile } from "../config/soul.ts";
import { loadSkills, formatSkillsForPrompt } from "../skills/loader.ts";

// Discord imports
import { Client as DiscordClient, GatewayIntentBits, REST, Routes } from "discord.js";

// Slack imports
import { WebClient } from "@slack/web-api";

// Telegram imports
import { Bot as TelegramBot } from "grammy";

// WhatsApp imports
import makeWASocket, {
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

type Platform = "discord" | "slack" | "telegram" | "whatsapp";

interface CLIArgs {
  platform: Platform;
  to: string;
  message?: string;
  agent?: boolean;
  raw?: boolean;
}

/** Simple logger for WhatsApp (Baileys) */
const baileysLogger = {
  level: "info",
  child: () => baileysLogger,
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** Parse CLI arguments */
function parseArgs(): CLIArgs {
  const args = process.argv.slice(2);
  const parsed: Partial<CLIArgs> = {
    agent: false,
    raw: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--platform" && i + 1 < args.length) {
      parsed.platform = args[++i] as Platform;
    } else if (arg === "--to" && i + 1 < args.length) {
      parsed.to = args[++i];
    } else if (arg === "--message" && i + 1 < args.length) {
      parsed.message = args[++i];
    } else if (arg === "--agent") {
      parsed.agent = true;
      parsed.raw = false;
    } else if (arg === "--raw") {
      parsed.raw = true;
      parsed.agent = false;
    }
  }

  if (!parsed.platform || !parsed.to) {
    console.error(
      "Usage: send.ts --platform <platform> --to <id> [--message <text>] [--agent|--raw]",
    );
    console.error("Platforms: discord, slack, telegram, whatsapp");
    process.exit(1);
  }

  return parsed as CLIArgs;
}

/** Read message from stdin if not provided via --message */
async function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => {
      resolve(data.trim());
    });
  });
}

/** Process message through Claude Agent if --agent flag is set */
async function processWithAgent(userMessage: string): Promise<string> {
  const cfg = loadEnvConfig();
  const [identity, profile] = await Promise.all([loadAgentIdentity(), loadUserProfile()]);

  const skills = loadSkills();
  const skillsPrompt = formatSkillsForPrompt(skills);
  const soulPrompt = loadSoulFile();

  const systemPromptAppend = buildSystemPromptAppend({
    profile,
    identity,
    skillsPrompt: skillsPrompt || undefined,
    soulPrompt: soulPrompt ?? undefined,
  });

  const memoryServer = createMemoryMcpServer();

  const session = runSession({
    prompt: userMessage,
    model: cfg.model,
    systemPromptAppend,
    mcpServers: { "nomos-memory": memoryServer },
    allowedTools: ["mcp__nomos-memory"],
    permissionMode: cfg.permissionMode,
    maxTurns: 10,
  });

  let fullResponse = "";

  for await (const event of session) {
    if (event.type === "result") {
      for (const block of event.result) {
        if (block.type === "text") {
          fullResponse += block.text;
        }
      }
    }
  }

  return fullResponse.trim() || "*(no response)*";
}

/** Send message via Discord */
async function sendDiscord(channelId: string, message: string): Promise<void> {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    throw new Error("DISCORD_BOT_TOKEN is required");
  }

  const rest = new REST({ version: "10" }).setToken(token);

  console.log(`[discord] Sending to channel ${channelId}...`);
  await rest.post(Routes.channelMessages(channelId), {
    body: { content: message },
  });
  console.log("[discord] Message sent successfully");
}

/** Send message via Slack */
async function sendSlack(channel: string, message: string): Promise<void> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) {
    throw new Error("SLACK_BOT_TOKEN is required");
  }

  const client = new WebClient(token);

  console.log(`[slack] Sending to channel ${channel}...`);
  const result = await client.chat.postMessage({
    channel,
    text: message,
  });

  if (result.ok) {
    console.log("[slack] Message sent successfully");
  } else {
    throw new Error(`Slack API error: ${result.error}`);
  }
}

/** Send message via Telegram */
async function sendTelegram(chatId: string, message: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN is required");
  }

  const bot = new TelegramBot(token);

  console.log(`[telegram] Sending to chat ${chatId}...`);
  await bot.api.sendMessage(chatId, message);
  console.log("[telegram] Message sent successfully");
}

/** Send message via WhatsApp */
async function sendWhatsApp(jid: string, message: string): Promise<void> {
  const authDir = path.join(os.homedir(), ".nomos", "whatsapp-auth");

  if (!fs.existsSync(authDir)) {
    throw new Error(
      "WhatsApp session not found. Please run the WhatsApp integration first to authenticate.",
    );
  }

  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();

  console.log("[whatsapp] Connecting...");

  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
    },
    printQRInTerminal: false,
  });

  // Wait for connection
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("WhatsApp connection timeout"));
    }, 30000);

    sock.ev.on("connection.update", (update) => {
      const { connection } = update;
      if (connection === "open") {
        clearTimeout(timeout);
        resolve();
      } else if (connection === "close") {
        clearTimeout(timeout);
        reject(new Error("WhatsApp connection failed"));
      }
    });

    sock.ev.on("creds.update", saveCreds);
  });

  console.log(`[whatsapp] Sending to ${jid}...`);
  await sock.sendMessage(jid, { text: message });
  console.log("[whatsapp] Message sent successfully");

  // Close connection
  sock.end(undefined);
}

/** Main function */
async function main() {
  const args = parseArgs();

  // Get message from --message flag or stdin
  let message = args.message;
  if (!message) {
    if (process.stdin.isTTY) {
      console.error("Error: --message required when not piping input");
      process.exit(1);
    }
    message = await readStdin();
  }

  if (!message) {
    console.error("Error: message cannot be empty");
    process.exit(1);
  }

  // Process with agent if --agent flag is set (default is raw)
  const finalMessage = args.agent ? await processWithAgent(message) : message;

  // Send via platform
  try {
    switch (args.platform) {
      case "discord":
        await sendDiscord(args.to, finalMessage);
        break;
      case "slack":
        await sendSlack(args.to, finalMessage);
        break;
      case "telegram":
        await sendTelegram(args.to, finalMessage);
        break;
      case "whatsapp":
        await sendWhatsApp(args.to, finalMessage);
        break;
      default:
        console.error(`Unknown platform: ${args.platform}`);
        process.exit(1);
    }
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error(`[${args.platform}] Error:`, errMsg);
    process.exit(1);
  }
}

// Run if this file is the entry point
const isMain = process.argv[1]?.endsWith("send.ts") || process.argv[1]?.endsWith("send.js");
if (isMain) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
