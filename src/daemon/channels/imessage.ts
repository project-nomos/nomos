/**
 * iMessage channel adapter for the daemon.
 *
 * Powered by the `imsg` CLI (https://github.com/openclaw/imsg) -- a local-first
 * iMessage tool that reads chat.db directly and sends through Messages.app.
 *
 * Two feature modes (controlled by IMESSAGE_FEATURE_MODE env var or settings):
 * - "basic" (default): read/watch/send/standard tapbacks/attachments. No setup
 *   beyond Full Disk Access + Automation permission.
 * - "advanced": adds edit, unsend, typing indicators, custom emoji reactions,
 *   group management, effects. Requires SIP disabled and `imsg launch`.
 *
 * Two agent modes (controlled by IMESSAGE_AGENT_MODE):
 * - "passive": drafts responses for approval via DraftManager (default)
 * - "agent": only processes messages from the owner, responds directly
 *
 * Install:  brew install steipete/tap/imsg
 */

import { ImsgAdapter, type ImsgFeatureMode } from "./imessage-imsg.ts";
import type { ChannelAdapter, IncomingMessage, OutgoingMessage } from "../types.ts";
import type { DraftManager } from "../draft-manager.ts";

const MAX_LENGTH = 4000;

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

export type IMessageAgentMode = "passive" | "agent";
export type { ImsgFeatureMode as IMessageFeatureMode };

export interface IMessageAdapterOptions {
  onMessage: (msg: IncomingMessage) => void;
  /** Agent mode: "passive" drafts responses for approval, "agent" responds directly to owner only */
  agentMode?: IMessageAgentMode;
  /** Feature mode: "basic" (default) or "advanced" (SIP disabled required) */
  featureMode?: ImsgFeatureMode;
  /** Owner identities for agent mode -- only messages from these are processed */
  ownerIdentities?: Set<string>;
  /** Draft manager for passive mode -- routes responses through approval flow */
  draftManager?: DraftManager;
}

export class IMessageAdapter implements ChannelAdapter {
  readonly platform = "imessage";
  private agentMode: IMessageAgentMode;
  private featureMode: ImsgFeatureMode;
  private ownerIdentities: Set<string>;
  private onMessage: (msg: IncomingMessage) => void;
  private draftManager?: DraftManager;
  private imsg: ImsgAdapter | null = null;

  // Cache last incoming message per channel so send() can include originalMessage in drafts
  private lastIncomingContext = new Map<string, Record<string, unknown>>();

  constructor(options: IMessageAdapterOptions) {
    this.onMessage = options.onMessage;
    this.agentMode =
      options.agentMode ?? ((process.env.IMESSAGE_AGENT_MODE as IMessageAgentMode) || "passive");
    this.featureMode =
      options.featureMode ?? ((process.env.IMESSAGE_FEATURE_MODE as ImsgFeatureMode) || "basic");
    this.draftManager = options.draftManager;

    // Build owner identity set from options or env
    this.ownerIdentities = options.ownerIdentities ?? new Set<string>();
    if (this.ownerIdentities.size === 0) {
      const phone = process.env.IMESSAGE_OWNER_PHONE?.trim();
      const appleId = process.env.IMESSAGE_OWNER_APPLE_ID?.trim();
      if (phone) this.ownerIdentities.add(phone);
      if (appleId) this.ownerIdentities.add(appleId);
    }
  }

  async start(): Promise<void> {
    if (process.platform !== "darwin") {
      throw new Error("iMessage requires macOS. The imsg CLI is macOS-only for sending.");
    }

    // Verify imsg CLI is installed
    const check = await ImsgAdapter.isInstalled();
    if (!check.installed) {
      throw new Error("imsg CLI is not installed. Install it with: brew install steipete/tap/imsg");
    }

    if (this.agentMode === "agent" && this.ownerIdentities.size === 0) {
      console.warn(
        "[imessage-adapter] Agent mode requires owner phone or Apple ID. " +
          "Set IMESSAGE_OWNER_PHONE or IMESSAGE_OWNER_APPLE_ID, or use passive mode.",
      );
    }

    console.log(
      `[imessage-adapter] Starting (agent: ${this.agentMode}, features: ${this.featureMode}, imsg: ${check.version})` +
        (this.agentMode === "agent" ? `, owner: ${[...this.ownerIdentities].join(", ")}` : ""),
    );

    this.imsg = new ImsgAdapter({
      featureMode: this.featureMode,
      ownerOnly: this.agentMode === "agent",
      ownerIdentities: this.ownerIdentities,
      onMessage: (msg) => this.handleIncoming(msg),
    });

    await this.imsg.start();
  }

  async stop(): Promise<void> {
    if (this.imsg) {
      await this.imsg.stop();
      this.imsg = null;
    }
    this.lastIncomingContext.clear();
  }

  async send(message: OutgoingMessage): Promise<void> {
    // Passive mode: route through draft manager for approval
    if (this.agentMode === "passive" && this.draftManager) {
      const cachedCtx = this.lastIncomingContext.get(message.channelId) ?? {};
      const senderName = (cachedCtx.senderName as string) ?? message.channelId;
      await this.draftManager.createDraft(message, "imessage-passive", {
        messageType: "dm",
        senderName,
        channelId: message.channelId,
        agentMode: "passive",
        ...cachedCtx,
      });
      this.lastIncomingContext.delete(message.channelId);
      return;
    }

    // Agent mode (or no draft manager): send directly
    await this.sendDirect(message);
  }

  /**
   * Send directly, bypassing draft approval. Called by DraftManager after approval
   * and by agent mode.
   */
  async sendDirect(message: OutgoingMessage): Promise<void> {
    if (!this.imsg) {
      throw new Error("imsg adapter not started");
    }

    const chunks = chunk(message.content);
    for (const text of chunks) {
      await this.imsg.sendText(message.channelId, text);
    }
  }

  /** Send a standard tapback reaction. */
  async react(
    chatId: string,
    reaction: "love" | "like" | "dislike" | "laugh" | "emphasis" | "question",
  ): Promise<void> {
    if (!this.imsg) throw new Error("imsg adapter not started");
    await this.imsg.react(chatId, reaction);
  }

  /** Send a file attachment. */
  async sendFile(handle: string, filePath: string): Promise<void> {
    if (!this.imsg) throw new Error("imsg adapter not started");
    await this.imsg.sendFile(handle, filePath);
  }

  /** Show typing indicator (advanced mode only). */
  async showTyping(handle: string, durationSec = 5): Promise<void> {
    if (!this.imsg) throw new Error("imsg adapter not started");
    await this.imsg.typing(handle, durationSec);
  }

  /** Edit a sent message (advanced mode only). */
  async editMessage(messageGuid: string, newText: string): Promise<void> {
    if (!this.imsg) throw new Error("imsg adapter not started");
    await this.imsg.editMessage(messageGuid, newText);
  }

  /** Unsend a message (advanced mode only). */
  async unsendMessage(messageGuid: string): Promise<void> {
    if (!this.imsg) throw new Error("imsg adapter not started");
    await this.imsg.unsendMessage(messageGuid);
  }

  /** Send a custom emoji tapback (advanced mode only). */
  async customTapback(messageGuid: string, emoji: string): Promise<void> {
    if (!this.imsg) throw new Error("imsg adapter not started");
    await this.imsg.customTapback(messageGuid, emoji);
  }

  private handleIncoming(msg: IncomingMessage): void {
    // Cache context so send() can enrich drafts with sender info / original message
    const prevCtx = this.lastIncomingContext.get(msg.channelId);
    const senderName = (msg.metadata?.senderName as string) ?? msg.userId;
    const prevOriginal =
      prevCtx?.senderName === senderName ? (prevCtx.originalMessage as string) : "";
    this.lastIncomingContext.set(msg.channelId, {
      senderName,
      messageType: msg.metadata?.messageType ?? "dm",
      originalMessage: prevOriginal ? `${prevOriginal}\n${msg.content}` : msg.content,
    });

    this.onMessage(msg);
  }
}
