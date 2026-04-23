/**
 * Photon iMessage adapter.
 *
 * Connects to a Photon iMessage server via the @photon-ai/advanced-imessage-kit
 * SDK. Provides full-featured iMessage support: sending, receiving, reactions,
 * typing indicators, scheduled messages, contact cards, and more.
 *
 * Requires a Photon server running on a Mac with Messages.app signed in.
 * The daemon can run on any platform -- the Mac relays via HTTP + Socket.IO.
 */

import { AdvancedIMessageKit, type MessageResponse } from "@photon-ai/advanced-imessage-kit";
import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "../types.ts";

export interface PhotonConfig {
  serverUrl: string;
  apiKey?: string;
}

export class PhotonAdapter {
  private sdk: AdvancedIMessageKit | null = null;
  private config: PhotonConfig;
  private onMessage: (msg: IncomingMessage) => void;

  constructor(config: PhotonConfig, onMessage: (msg: IncomingMessage) => void) {
    this.config = config;
    this.onMessage = onMessage;
  }

  async start(): Promise<void> {
    this.sdk = AdvancedIMessageKit.getInstance({
      serverUrl: this.config.serverUrl,
      apiKey: this.config.apiKey,
      logLevel: "warn",
    });

    // Listen for new messages
    this.sdk.on("new-message", (message: MessageResponse) => {
      if (message.isFromMe) return;

      const senderAddress = message.handle?.address ?? "unknown";
      const chatGuid = message.chats?.[0]?.guid ?? "";
      const chatIdentifier = message.chats?.[0]?.chatIdentifier ?? senderAddress;
      const displayName = message.chats?.[0]?.displayName ?? "";
      const chatStyle = message.chats?.[0]?.style ?? 43;

      this.onMessage({
        id: randomUUID(),
        platform: "imessage",
        channelId: chatIdentifier,
        userId: senderAddress,
        content: message.text ?? "",
        timestamp: new Date(message.dateCreated),
        metadata: {
          senderName: displayName || senderAddress,
          messageType: "dm",
          handleIdentifier: senderAddress,
          chatGuid,
          chatStyle,
          photonGuid: message.guid,
        },
      });
    });

    await this.sdk.connect();
    console.log(`[imessage-photon] Connected to Photon server at ${this.config.serverUrl}`);
  }

  async stop(): Promise<void> {
    if (this.sdk) {
      await this.sdk.close();
      this.sdk = null;
    }
  }

  /** Send a text message to a chat. */
  async sendMessage(chatGuid: string, text: string): Promise<string | undefined> {
    if (!this.sdk) return undefined;
    const result = await this.sdk.messages.sendMessage({ chatGuid, message: text });
    return result.guid;
  }

  /** Send a message to a contact by phone/email (resolves chat GUID automatically). */
  async sendToContact(address: string, text: string): Promise<string | undefined> {
    if (!this.sdk) return undefined;

    // Find or create chat with this address
    const chats = await this.sdk.chats.getChats({ withLastMessage: false });
    let chatGuid = chats.find((c) => c.chatIdentifier === address)?.guid;

    if (!chatGuid) {
      // Create a new chat
      const created = await this.sdk.chats.createChat({
        addresses: [address],
        message: text,
      });
      return created.lastMessage?.guid;
    }

    return this.sendMessage(chatGuid, text);
  }

  /** Send a tapback reaction to a message. */
  async sendReaction(chatGuid: string, messageGuid: string, reaction: string): Promise<void> {
    if (!this.sdk) return;
    await this.sdk.messages.sendReaction({ chatGuid, messageGuid, reaction });
  }

  /** Read recent messages from a chat. */
  async getMessages(
    chatGuid: string,
    options?: { limit?: number; after?: number },
  ): Promise<MessageResponse[]> {
    if (!this.sdk) return [];
    return this.sdk.chats.getChatMessages(chatGuid, {
      limit: options?.limit ?? 20,
      after: options?.after,
      sort: "DESC",
    });
  }

  /** List all chats. */
  async getChats(): Promise<Array<{ guid: string; identifier: string; displayName: string }>> {
    if (!this.sdk) return [];
    const chats = await this.sdk.chats.getChats({ withLastMessage: true, limit: 50 });
    return chats.map((c) => ({
      guid: c.guid,
      identifier: c.chatIdentifier,
      displayName: c.displayName ?? c.chatIdentifier,
    }));
  }

  /** Check if the server is reachable. */
  async ping(): Promise<boolean> {
    if (!this.sdk) return false;
    try {
      await this.sdk.server.getServerInfo();
      return true;
    } catch {
      return false;
    }
  }

  /** Get the underlying SDK instance (for advanced operations). */
  getSdk(): AdvancedIMessageKit | null {
    return this.sdk;
  }
}
