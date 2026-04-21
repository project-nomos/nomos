/**
 * DraftManager: orchestrates draft creation, approval, and sending.
 *
 * Sits between the SlackUserAdapter (which intercepts outgoing messages)
 * and the actual send functions (which post as the user after approval).
 */

import {
  createDraft as dbCreateDraft,
  approveDraft as dbApproveDraft,
  rejectDraft as dbRejectDraft,
  markDraftSent,
} from "../db/drafts.ts";
import type { DraftRow } from "../db/drafts.ts";
import type { OutgoingMessage, AgentEvent } from "./types.ts";
import { findContactByIdentity } from "../identity/identities.ts";

export interface DraftManagerOptions {
  /** Broadcast a system event to all WebSocket clients */
  notifyWs?: (event: AgentEvent) => void;
  /** Send a Slack DM to the user with approval buttons */
  notifySlack?: (userId: string, draft: DraftRow) => Promise<void>;
}

type SendFn = (channelId: string, text: string, threadId?: string) => Promise<void>;

export class DraftManager {
  private sendFns = new Map<string, SendFn>();
  private notifyWs?: (event: AgentEvent) => void;
  private notifySlack?: (userId: string, draft: DraftRow) => Promise<void>;

  constructor(options: DraftManagerOptions = {}) {
    this.notifyWs = options.notifyWs;
    this.notifySlack = options.notifySlack;
  }

  /**
   * Register a platform-specific send function.
   * Called by the gateway after the adapter starts.
   */
  registerSendFn(platform: string, fn: SendFn): void {
    this.sendFns.set(platform, fn);
  }

  /**
   * Create a draft from an outgoing message.
   * Checks the recipient contact's autonomy level:
   * - "auto": send immediately without drafting
   * - "silent": discard the message silently
   * - "draft" (default): create a draft for approval
   */
  async createDraft(
    message: OutgoingMessage,
    userId: string,
    context: Record<string, unknown> = {},
  ): Promise<DraftRow | null> {
    // Check contact autonomy level
    const autonomy = await this.resolveAutonomy(message.platform, message.channelId);

    if (autonomy === "auto") {
      // Send directly without drafting
      const sendFn = this.sendFns.get(message.platform);
      if (sendFn) {
        await sendFn(message.channelId, message.content, message.threadId);
        console.log(`[draft-manager] Auto-sent to ${message.channelId} (autonomy: auto)`);
        this.notifyWs?.({
          type: "system",
          subtype: "auto_sent",
          message: `Message auto-sent on ${message.platform} to ${message.channelId}`,
          data: {
            platform: message.platform,
            channelId: message.channelId,
            autonomy: "auto",
            preview: message.content.slice(0, 120),
          },
        });
      }
      return null;
    }

    if (autonomy === "silent") {
      console.log(`[draft-manager] Discarded message to ${message.channelId} (autonomy: silent)`);
      this.notifyWs?.({
        type: "system",
        subtype: "message_silenced",
        message: `Message to ${message.channelId} silenced (autonomy: silent)`,
        data: {
          platform: message.platform,
          channelId: message.channelId,
          autonomy: "silent",
        },
      });
      return null;
    }

    const draft = await dbCreateDraft({
      platform: message.platform,
      channelId: message.channelId,
      threadId: message.threadId,
      userId,
      inReplyTo: message.inReplyTo,
      content: message.content,
      context,
    });

    // Notify WebSocket clients
    this.notifyWs?.({
      type: "system",
      subtype: "draft_created",
      message: `Draft response ready (${draft.id.slice(0, 8)})`,
      data: {
        draftId: draft.id,
        platform: draft.platform,
        channelId: draft.channel_id,
        preview: draft.content.slice(0, 100),
        context,
      },
    });

    // Notify via Slack bot DM
    if (this.notifySlack) {
      this.notifySlack(userId, draft).catch((err) =>
        console.error("[draft-manager] Failed to send Slack notification:", err),
      );
    }

    console.log(`[draft-manager] Draft created: ${draft.id.slice(0, 8)} for ${userId}`);
    return draft;
  }

  /**
   * Approve a draft: mark it approved, send the message, mark it sent.
   */
  async approve(draftId: string): Promise<{ success: boolean; error?: string }> {
    const draft = await dbApproveDraft(draftId);
    if (!draft) {
      return { success: false, error: "Draft not found or already processed" };
    }

    const sendFn = this.sendFns.get(draft.platform);
    if (!sendFn) {
      return { success: false, error: `No send function registered for ${draft.platform}` };
    }

    try {
      await sendFn(draft.channel_id, draft.content, draft.thread_id ?? undefined);
      await markDraftSent(draft.id);

      this.notifyWs?.({
        type: "system",
        subtype: "draft_approved",
        message: `Draft ${draft.id.slice(0, 8)} approved and sent`,
        data: { draftId: draft.id },
      });

      console.log(`[draft-manager] Draft approved and sent: ${draft.id.slice(0, 8)}`);
      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[draft-manager] Failed to send approved draft ${draft.id.slice(0, 8)}:`,
        message,
      );
      return { success: false, error: `Send failed: ${message}` };
    }
  }

  /**
   * Reject a draft: mark it rejected, no message is sent.
   */
  async reject(draftId: string): Promise<{ success: boolean; error?: string }> {
    const draft = await dbRejectDraft(draftId);
    if (!draft) {
      return { success: false, error: "Draft not found or already processed" };
    }

    this.notifyWs?.({
      type: "system",
      subtype: "draft_rejected",
      message: `Draft ${draft.id.slice(0, 8)} rejected`,
      data: { draftId: draft.id },
    });

    console.log(`[draft-manager] Draft rejected: ${draft.id.slice(0, 8)}`);
    return { success: true };
  }

  /**
   * Look up the autonomy level for a contact based on platform + channel/user ID.
   * Falls back to "draft" if no contact is found.
   */
  private async resolveAutonomy(
    platform: string,
    channelId: string,
  ): Promise<"auto" | "draft" | "silent"> {
    try {
      const contact = await findContactByIdentity(platform, channelId);
      if (contact) {
        return contact.autonomy;
      }
    } catch {
      // Identity graph not available or DB error — fall back to draft
    }
    return "draft";
  }
}
