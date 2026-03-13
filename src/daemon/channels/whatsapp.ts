/**
 * Thin WhatsApp channel adapter for the daemon.
 */

import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
  type WASocket,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";
import type { ChannelAdapter, IncomingMessage, OutgoingMessage } from "../types.ts";

const MAX_LENGTH = 4096;

function chunk(text: string): string[] {
  if (text.length <= MAX_LENGTH) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= MAX_LENGTH) {
      chunks.push(remaining);
      break;
    }
    let idx = remaining.lastIndexOf("\n", MAX_LENGTH);
    if (idx < MAX_LENGTH / 2) idx = remaining.lastIndexOf(" ", MAX_LENGTH);
    if (idx < MAX_LENGTH / 2) idx = MAX_LENGTH;
    chunks.push(remaining.slice(0, idx));
    remaining = remaining.slice(idx).trimStart();
  }
  return chunks;
}

const logger = {
  level: "info",
  child: () => logger,
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

export class WhatsAppAdapter implements ChannelAdapter {
  readonly platform = "whatsapp";
  private sock: WASocket | null = null;
  private onMessage: (msg: IncomingMessage) => void;

  constructor(onMessage: (msg: IncomingMessage) => void) {
    this.onMessage = onMessage;
  }

  async start(): Promise<void> {
    const authDir = path.join(os.homedir(), ".nomos", "whatsapp-auth");
    fs.mkdirSync(authDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const { version } = await fetchLatestBaileysVersion();

    const connectToWhatsApp = async () => {
      this.sock = makeWASocket({
        version,
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
        printQRInTerminal: true,
      });

      this.sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === "close") {
          const shouldReconnect =
            (lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
          if (shouldReconnect) {
            await connectToWhatsApp();
          }
        } else if (connection === "open") {
          console.log(`[whatsapp-adapter] Connected as ${this.sock?.user?.id}`);
        }
      });

      this.sock.ev.on("creds.update", saveCreds);

      this.sock.ev.on("messages.upsert", async ({ messages }) => {
        for (const msg of messages) {
          if (msg.key?.fromMe || msg.key?.remoteJid === "status@broadcast") continue;
          const jid = msg.key?.remoteJid;
          if (!jid) continue;

          const botNumber = this.sock?.user?.id;
          if (!botNumber) continue;

          // Individual chats always respond; groups when mentioned or with trigger prefix
          if (jid.endsWith("@g.us")) {
            const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || "";
            const mentions = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
            const isMentioned = mentions.some((m) => m === botNumber);
            if (!isMentioned && !/^[\/!@]/.test(text.trim())) continue;
          }

          const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || "";
          const content = text
            .replace(new RegExp(`@${botNumber.split("@")[0]}`, "g"), "")
            .replace(/^[\/!@]\s*/, "")
            .trim();
          if (!content) continue;

          this.onMessage({
            id: randomUUID(),
            platform: "whatsapp",
            channelId: jid,
            userId: msg.key.participant ?? jid,
            content,
            timestamp: new Date(),
          });
        }
      });
    };

    await connectToWhatsApp();
  }

  async stop(): Promise<void> {
    if (this.sock) {
      this.sock.end(undefined);
      this.sock = null;
    }
  }

  async send(message: OutgoingMessage): Promise<void> {
    if (!this.sock) return;
    const chunks = chunk(message.content);
    for (const text of chunks) {
      await this.sock.sendMessage(message.channelId, { text });
    }
  }
}
