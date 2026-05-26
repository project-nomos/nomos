/**
 * imsg CLI adapter for iMessage.
 *
 * Wraps the `imsg` CLI (https://github.com/openclaw/imsg) -- a local-first
 * iMessage tool that reads chat.db directly, watches via filesystem events,
 * and sends through Messages.app via AppleScript (basic mode) or IMCore
 * (advanced mode, requires SIP disabled).
 *
 * Two feature modes:
 * - "basic" (default, no setup): read/watch/send/standard tapbacks/attachments
 * - "advanced" (requires SIP disabled + `imsg launch`): adds edit, unsend,
 *   typing indicators, effects, custom emoji reactions, group management
 *
 * Install:  brew install steipete/tap/imsg
 * Advanced: csrutil disable (in Recovery Mode), then `imsg launch` once
 */

import { spawn, execFile, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import type { IncomingMessage } from "../types.ts";
import { createLogger } from "../../lib/logger.ts";

const log = createLogger("imessage-imsg");

const execFileAsync = promisify(execFile);

export type ImsgFeatureMode = "basic" | "advanced";

/** Standard tapback reactions supported in basic mode. */
export type StandardTapback = "love" | "like" | "dislike" | "laugh" | "emphasis" | "question";

/** imsg JSON message shape (subset we care about). */
export interface ImsgMessage {
  id: number;
  chat_id: number;
  chat_identifier: string;
  chat_guid: string;
  chat_name?: string;
  participants?: string[];
  is_group: boolean;
  guid: string;
  sender: string;
  sender_name?: string;
  is_from_me: boolean;
  text: string;
  created_at: string;
  attachments?: Array<{
    filename: string;
    mime_type?: string;
    resolved_path?: string;
  }>;
  is_reaction?: boolean;
  reaction_type?: string;
  reacted_to_guid?: string;
}

export interface ImsgAdapterOptions {
  /** Called for each new incoming message. */
  onMessage: (msg: IncomingMessage) => void;
  /** Feature mode: "basic" (default) or "advanced" (requires SIP off). */
  featureMode?: ImsgFeatureMode;
  /** When true, only forward messages from the owner (filter by sender handle). */
  ownerOnly?: boolean;
  /** Owner handles (phone/email) to match in agent mode. */
  ownerIdentities?: Set<string>;
}

/**
 * Adapter that wraps `imsg watch --json` for incoming and `imsg send` for outgoing.
 */
export class ImsgAdapter {
  private featureMode: ImsgFeatureMode;
  private onMessage: (msg: IncomingMessage) => void;
  private ownerOnly: boolean;
  private ownerIdentities: Set<string>;
  private watchProc: ChildProcess | null = null;
  private stopping = false;

  constructor(options: ImsgAdapterOptions) {
    this.featureMode = options.featureMode ?? "basic";
    this.onMessage = options.onMessage;
    this.ownerOnly = options.ownerOnly ?? false;
    this.ownerIdentities = options.ownerIdentities ?? new Set();
  }

  /** Verify imsg CLI is installed. */
  static async isInstalled(): Promise<{ installed: boolean; version?: string }> {
    try {
      const { stdout } = await execFileAsync("imsg", ["--version"], { timeout: 5000 });
      return { installed: true, version: stdout.trim() };
    } catch {
      return { installed: false };
    }
  }

  async start(): Promise<void> {
    // Advanced mode: load IMCore bridge (requires SIP disabled).
    // Idempotent -- safe to call repeatedly; reports if SIP is enabled.
    if (this.featureMode === "advanced") {
      try {
        await execFileAsync("imsg", ["launch"], { timeout: 15_000 });
        log.info("Advanced IMCore bridge loaded");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(
          `Advanced mode requested but launch failed: ${msg}. ` +
            "Disable SIP (csrutil disable in Recovery Mode) to use edit/unsend/typing.",
        );
      }
    }

    // Spawn `imsg watch --json --reactions` as a long-running process.
    // It streams new messages and tapbacks as newline-delimited JSON to stdout.
    this.watchProc = spawn("imsg", ["watch", "--json", "--reactions", "--attachments"], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    this.watchProc.on("error", (err) => {
      log.error({ err: err.message }, "Watch process error");
    });

    this.watchProc.on("exit", (code) => {
      if (!this.stopping) {
        log.warn(`Watch process exited with code ${code}`);
      }
      this.watchProc = null;
    });

    // Parse JSON lines from stdout
    const rl = createInterface({ input: this.watchProc.stdout!, crlfDelay: Infinity });
    rl.on("line", (line) => this.handleLine(line));

    // Log stderr (progress + warnings)
    this.watchProc.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) log.info({ stderr: text }, "imsg stderr");
    });

    log.info(`Started in ${this.featureMode} mode (watching chat.db)`);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.watchProc) {
      this.watchProc.kill("SIGTERM");
      this.watchProc = null;
    }
  }

  /** Send a text message. */
  async sendText(handle: string, text: string): Promise<void> {
    await execFileAsync("imsg", ["send", "--to", handle, "--text", text], { timeout: 30_000 });
  }

  /** Send a file (image, audio, document). */
  async sendFile(handle: string, filePath: string): Promise<void> {
    await execFileAsync("imsg", ["send", "--to", handle, "--file", filePath], {
      timeout: 60_000,
    });
  }

  /** Send a standard tapback reaction (works in basic mode). */
  async react(chatId: string | number, reaction: StandardTapback): Promise<void> {
    await execFileAsync("imsg", ["react", "--chat-id", String(chatId), "--reaction", reaction], {
      timeout: 15_000,
    });
  }

  // ── Advanced mode features (require SIP disabled + `imsg launch`) ──

  /** Show typing indicator (advanced mode). */
  async typing(handle: string, durationSec = 5): Promise<void> {
    if (this.featureMode !== "advanced") {
      throw new Error("Typing indicators require advanced mode (SIP disabled)");
    }
    await execFileAsync("imsg", ["typing", "--to", handle, "--duration", `${durationSec}s`], {
      timeout: 10_000,
    });
  }

  /** Edit a previously sent message (advanced mode). */
  async editMessage(guid: string, newText: string): Promise<void> {
    if (this.featureMode !== "advanced") {
      throw new Error("Edit requires advanced mode (SIP disabled)");
    }
    await execFileAsync("imsg", ["edit", "--guid", guid, "--text", newText], { timeout: 15_000 });
  }

  /** Unsend a previously sent message (advanced mode). */
  async unsendMessage(guid: string): Promise<void> {
    if (this.featureMode !== "advanced") {
      throw new Error("Unsend requires advanced mode (SIP disabled)");
    }
    await execFileAsync("imsg", ["unsend", "--guid", guid], { timeout: 15_000 });
  }

  /** Send a custom emoji tapback (advanced mode). */
  async customTapback(messageGuid: string, emoji: string): Promise<void> {
    if (this.featureMode !== "advanced") {
      throw new Error("Custom tapbacks require advanced mode (SIP disabled)");
    }
    await execFileAsync("imsg", ["tapback", "--reply-to", messageGuid, "--emoji", emoji], {
      timeout: 15_000,
    });
  }

  // ── Internal ──

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith("{")) return;

    try {
      const msg = JSON.parse(trimmed) as ImsgMessage;
      this.processMessage(msg);
    } catch (err) {
      log.warn({ err }, "Failed to parse JSON line");
    }
  }

  private processMessage(msg: ImsgMessage): void {
    // Skip our own outgoing messages
    if (msg.is_from_me) return;
    // Skip reaction events for now (could be exposed later)
    if (msg.is_reaction) return;
    // Skip empty messages (e.g., attachment-only with no text)
    if (!msg.text && !msg.attachments?.length) return;

    // Owner-only filter for agent mode
    if (this.ownerOnly && !this.ownerIdentities.has(msg.sender)) return;

    const content =
      msg.text ||
      (msg.attachments?.length
        ? `[${msg.attachments.length} attachment(s): ${msg.attachments.map((a) => a.filename).join(", ")}]`
        : "");

    this.onMessage({
      id: randomUUID(),
      platform: "imessage",
      channelId: msg.chat_identifier,
      userId: msg.sender,
      content,
      timestamp: new Date(msg.created_at),
      metadata: {
        senderName: msg.sender_name || msg.sender,
        messageType: msg.is_group ? "group" : "dm",
        handleIdentifier: msg.sender,
        chatGuid: msg.chat_guid,
        chatId: msg.chat_id,
        messageGuid: msg.guid,
        isGroup: msg.is_group,
        attachments: msg.attachments,
      },
    });
  }
}
