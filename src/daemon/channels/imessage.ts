/**
 * Thin iMessage channel adapter for the daemon.
 *
 * Supports two connection modes:
 * - "chatdb" (default): macOS only. Reads from ~/Library/Messages/chat.db,
 *   sends via AppleScript. Zero setup, but macOS-only.
 * - "bluebubbles": Connects to a BlueBubbles server via REST + webhooks.
 *   Works cross-platform -- the daemon can run anywhere while a Mac relays.
 *
 * Supports two agent modes:
 * - "passive": Listens to all incoming messages, processes them through the
 *   agent, but routes responses through DraftManager for approval before sending.
 * - "agent": Only processes messages from the owner (phone number / Apple ID),
 *   responds directly. Acts as a personal agent client.
 *
 * Mode is selected via IMESSAGE_AGENT_MODE env var or Settings UI.
 */

import { randomUUID } from "node:crypto";
import { IMessageReceiver } from "./imessage-receiver.ts";
import { sendIMessage } from "./imessage-sender.ts";
import { BlueBubblesAdapter, type BlueBubblesConfig } from "./imessage-bluebubbles.ts";
import { PhotonAdapter, type PhotonConfig } from "./imessage-photon.ts";
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

/** Chat style: 45 = group chat (43 = 1:1, handled as the else case). */
const STYLE_GROUP = 45;

export type IMessageMode = "chatdb" | "bluebubbles" | "photon";
export type IMessageAgentMode = "passive" | "agent";

interface ChatMeta {
  chatGuid: string;
  chatStyle: number;
  handleIdentifier: string;
}

export interface IMessageAdapterOptions {
  onMessage: (msg: IncomingMessage) => void;
  /** Agent mode: "passive" drafts responses for approval, "agent" responds directly to owner only */
  agentMode?: IMessageAgentMode;
  /** Owner identities for agent mode -- only messages from these are processed */
  ownerIdentities?: Set<string>;
  /** Draft manager for passive mode -- routes responses through approval flow */
  draftManager?: DraftManager;
}

export class IMessageAdapter implements ChannelAdapter {
  readonly platform = "imessage";
  private imessageMode: IMessageMode;
  private agentMode: IMessageAgentMode;
  private ownerIdentities: Set<string>;
  private onMessage: (msg: IncomingMessage) => void;
  private draftManager?: DraftManager;

  // chatdb mode
  private receiver: IMessageReceiver | null = null;
  private chatMeta = new Map<string, ChatMeta>();

  // bluebubbles mode
  private bbAdapter: BlueBubblesAdapter | null = null;
  /** Map chatIdentifier -> chatGuid for BlueBubbles send routing. */
  private bbChatGuids = new Map<string, string>();

  // photon mode
  private photonAdapter: PhotonAdapter | null = null;

  constructor(options: IMessageAdapterOptions) {
    this.onMessage = options.onMessage;
    this.agentMode =
      options.agentMode ?? ((process.env.IMESSAGE_AGENT_MODE as IMessageAgentMode) || "passive");
    this.draftManager = options.draftManager;
    this.imessageMode = (process.env.IMESSAGE_MODE as IMessageMode) || "chatdb";

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
    if (this.agentMode === "agent" && this.ownerIdentities.size === 0) {
      console.warn(
        "[imessage-adapter] Agent mode requires owner phone or Apple ID. " +
          "Set IMESSAGE_OWNER_PHONE or IMESSAGE_OWNER_APPLE_ID, or use passive mode.",
      );
    }

    console.log(
      `[imessage-adapter] Starting in ${this.agentMode} mode` +
        (this.agentMode === "agent" ? ` (owner: ${[...this.ownerIdentities].join(", ")})` : ""),
    );

    if (this.imessageMode === "photon") {
      await this.startPhoton();
    } else if (this.imessageMode === "bluebubbles") {
      await this.startBlueBubbles();
    } else {
      await this.startChatDb();
    }
  }

  private async startChatDb(): Promise<void> {
    if (process.platform !== "darwin") {
      throw new Error(
        "iMessage chat.db mode requires macOS. Use IMESSAGE_MODE=bluebubbles for cross-platform.",
      );
    }

    const allowedChats = process.env.IMESSAGE_ALLOWED_CHATS
      ? new Set(process.env.IMESSAGE_ALLOWED_CHATS.split(",").map((s) => s.trim()))
      : null;

    this.receiver = new IMessageReceiver((msg) => {
      // Agent mode: only process messages from owner
      if (this.agentMode === "agent") {
        if (!this.isOwner(msg.handleIdentifier)) return;
      }

      // Passive mode with allowed chats filter
      if (this.agentMode === "passive" && allowedChats) {
        const allowed =
          allowedChats.has(msg.handleIdentifier) || allowedChats.has(msg.chatIdentifier);
        if (!allowed) return;
      }

      this.chatMeta.set(msg.chatIdentifier, {
        chatGuid: msg.chatGuid,
        chatStyle: msg.chatStyle,
        handleIdentifier: msg.handleIdentifier,
      });

      const senderName = msg.chatDisplayName || msg.handleIdentifier;
      this.onMessage({
        id: randomUUID(),
        platform: "imessage",
        channelId: msg.chatIdentifier,
        userId: msg.handleIdentifier,
        content: msg.text,
        timestamp: new Date(),
        metadata: { senderName, messageType: "dm", handleIdentifier: msg.handleIdentifier },
      });
    });

    this.receiver.start();
    console.log(
      `[imessage-adapter] Started in chat.db mode (${this.agentMode}) -- watching for incoming messages`,
    );
  }

  private async startBlueBubbles(): Promise<void> {
    const serverUrl = process.env.BLUEBUBBLES_SERVER_URL;
    const password = process.env.BLUEBUBBLES_PASSWORD;

    if (!serverUrl || !password) {
      throw new Error("BlueBubbles mode requires BLUEBUBBLES_SERVER_URL and BLUEBUBBLES_PASSWORD");
    }

    const allowedChats = process.env.IMESSAGE_ALLOWED_CHATS
      ? new Set(process.env.IMESSAGE_ALLOWED_CHATS.split(",").map((s) => s.trim()))
      : undefined;

    const config: BlueBubblesConfig = {
      serverUrl,
      password,
      webhookPort: process.env.BLUEBUBBLES_WEBHOOK_PORT
        ? Number.parseInt(process.env.BLUEBUBBLES_WEBHOOK_PORT)
        : 8803,
      webhookPassword: process.env.BLUEBUBBLES_WEBHOOK_PASSWORD ?? password,
      sendReadReceipts: process.env.BLUEBUBBLES_READ_RECEIPTS === "true",
      allowedChats,
    };

    this.bbAdapter = new BlueBubblesAdapter(config, (msg) => {
      // Agent mode: only process messages from owner
      if (this.agentMode === "agent") {
        if (!this.isOwner(msg.userId)) return;
      }

      // Track chat GUID for send routing
      this.bbChatGuids.set(msg.channelId, `iMessage;+;${msg.channelId}`);
      this.onMessage(msg);
    });

    // Verify connectivity
    const reachable = await this.bbAdapter.ping();
    if (!reachable) {
      console.warn(
        `[imessage-adapter] BlueBubbles server at ${serverUrl} is not reachable. Will retry on message send.`,
      );
    }

    await this.bbAdapter.startWebhook();
    console.log(
      `[imessage-adapter] Started in BlueBubbles mode (${this.agentMode}) -- server: ${serverUrl}`,
    );
  }

  private async startPhoton(): Promise<void> {
    const serverUrl = process.env.PHOTON_SERVER_URL;
    if (!serverUrl) {
      throw new Error("Photon mode requires PHOTON_SERVER_URL");
    }

    const config: PhotonConfig = {
      serverUrl,
      apiKey: process.env.PHOTON_API_KEY,
    };

    this.photonAdapter = new PhotonAdapter(config, (msg) => {
      // Agent mode: only process messages from owner
      if (this.agentMode === "agent") {
        if (!this.isOwner(msg.userId)) return;
      }

      this.onMessage(msg);
    });

    await this.photonAdapter.start();
    console.log(
      `[imessage-adapter] Started in Photon mode (${this.agentMode}) -- server: ${serverUrl}`,
    );
  }

  async stop(): Promise<void> {
    if (this.imessageMode === "photon" && this.photonAdapter) {
      await this.photonAdapter.stop();
      this.photonAdapter = null;
    } else if (this.imessageMode === "bluebubbles" && this.bbAdapter) {
      await this.bbAdapter.stop();
      this.bbAdapter = null;
      this.bbChatGuids.clear();
    } else {
      if (this.receiver) {
        this.receiver.stop();
        this.receiver = null;
      }
      this.chatMeta.clear();
    }
  }

  async send(message: OutgoingMessage): Promise<void> {
    // Passive mode: route through draft manager for approval
    if (this.agentMode === "passive" && this.draftManager) {
      // Look up sender info from cached metadata
      const meta = this.chatMeta.get(message.channelId);
      const senderName = meta?.handleIdentifier ?? message.channelId;
      await this.draftManager.createDraft(message, "imessage-passive", {
        messageType: "dm",
        senderName,
        channelId: message.channelId,
        agentMode: "passive",
      });
      return;
    }

    // Agent mode (or no draft manager): send directly
    await this.sendDirect(message);
  }

  /**
   * Send a message directly, bypassing draft approval.
   * Used by DraftManager after a draft is approved, and by agent mode.
   */
  async sendDirect(message: OutgoingMessage): Promise<void> {
    if (this.imessageMode === "photon") {
      await this.sendPhoton(message);
    } else if (this.imessageMode === "bluebubbles") {
      await this.sendBlueBubbles(message);
    } else {
      await this.sendChatDb(message);
    }
  }

  private async sendPhoton(message: OutgoingMessage): Promise<void> {
    if (!this.photonAdapter) {
      console.warn("[imessage-adapter] Photon adapter not initialized");
      return;
    }

    try {
      await this.photonAdapter.sendToContact(message.channelId, message.content);
    } catch (err) {
      console.error("[imessage-adapter] Photon send failed:", err);
    }
  }

  private async sendChatDb(message: OutgoingMessage): Promise<void> {
    const meta = this.chatMeta.get(message.channelId);
    if (!meta) {
      console.warn(`[imessage-adapter] No cached metadata for ${message.channelId}, cannot send`);
      return;
    }

    const target = meta.chatStyle === STYLE_GROUP ? meta.chatGuid : meta.handleIdentifier;

    const chunks = chunk(message.content);
    for (const text of chunks) {
      try {
        await sendIMessage(target, text);
      } catch (err) {
        console.error("[imessage-adapter] Send failed:", err);
      }
    }
  }

  private async sendBlueBubbles(message: OutgoingMessage): Promise<void> {
    if (!this.bbAdapter) {
      console.warn("[imessage-adapter] BlueBubbles adapter not initialized");
      return;
    }

    // Resolve chat GUID -- BlueBubbles needs the full GUID
    let chatGuid = this.bbChatGuids.get(message.channelId);
    if (!chatGuid) {
      // For 1:1 chats, construct the GUID from the handle
      chatGuid = `iMessage;-;${message.channelId}`;
    }

    try {
      await this.bbAdapter.sendMessage(chatGuid, message.content);
    } catch (err) {
      console.error("[imessage-adapter] BlueBubbles send failed:", err);
    }
  }

  /** Check if a handle identifier matches any owner identity. */
  private isOwner(handleIdentifier: string): boolean {
    if (this.ownerIdentities.size === 0) return false;
    // Direct match
    if (this.ownerIdentities.has(handleIdentifier)) return true;
    // Normalize: strip spaces/dashes from phone, lowercase email
    const normalized = handleIdentifier.replace(/[\s-]/g, "").toLowerCase();
    for (const identity of this.ownerIdentities) {
      if (identity.replace(/[\s-]/g, "").toLowerCase() === normalized) return true;
    }
    return false;
  }
}
