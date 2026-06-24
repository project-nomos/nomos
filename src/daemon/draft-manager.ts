/**
 * DraftManager: orchestrates draft creation, approval, editing, and sending.
 *
 * Unified consent system -- ALL channel adapters route outgoing messages
 * through this manager. Behavior is controlled by per-platform consent mode:
 *   - always_ask: create draft, post to default channel with Approve/Edit/Decline
 *   - auto_approve: send immediately, post FYI notification to default channel
 *   - notify_only: should not reach here (handled upstream in gateway)
 *
 * Per-contact autonomy (auto/draft/silent) is checked AFTER platform consent
 * for backwards compatibility with the identity graph.
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
import { resolveMemoryUserId } from "../auth/tenant-context.ts";
import { getConsentMode, type ConsentMode } from "../db/consent-config.ts";
import { createLogger } from "../lib/logger.ts";

const log = createLogger("draft-manager");

export interface DraftManagerOptions {
  /** Broadcast a system event to all connected clients (gRPC + WebSocket). */
  notifyWs?: (event: AgentEvent) => void;
  /** Post a draft notification to the default Slack channel. */
  notifyDefaultChannel?: (draft: DraftRow, context: Record<string, unknown>) => Promise<void>;
  /** Post an FYI (auto-approved) notification to the default Slack channel. */
  notifyDefaultChannelFyi?: (
    platform: string,
    channelId: string,
    content: string,
    context: Record<string, unknown>,
  ) => Promise<void>;
}

type SendFn = (channelId: string, text: string, threadId?: string) => Promise<void>;

/**
 * A custom approve action for a non-message draft "kind" (e.g. a Google Classroom
 * submission). Keyed by `draft.context.kind`. Receives the full draft (with its
 * context payload) and the edited content when approved-with-edit. Performs the
 * side effect (e.g. attach + turn in) instead of the per-platform channel send.
 */
export type ApproveActionFn = (draft: DraftRow, editedContent?: string) => Promise<void>;

export class DraftManager {
  private sendFns = new Map<string, SendFn>();
  private approveActions = new Map<string, ApproveActionFn>();
  private notifyWs?: (event: AgentEvent) => void;
  private notifyDefaultChannel?: (
    draft: DraftRow,
    context: Record<string, unknown>,
  ) => Promise<void>;
  private notifyDefaultChannelFyi?: (
    platform: string,
    channelId: string,
    content: string,
    context: Record<string, unknown>,
  ) => Promise<void>;

  constructor(options: DraftManagerOptions = {}) {
    this.notifyWs = options.notifyWs;
    this.notifyDefaultChannel = options.notifyDefaultChannel;
    this.notifyDefaultChannelFyi = options.notifyDefaultChannelFyi;
  }

  /**
   * Register a platform-specific send function.
   * Called by the gateway after the adapter starts.
   * IMPORTANT: This must point to sendDirect/sendAsUser, NOT send(),
   * to avoid infinite loops through createDraft().
   */
  registerSendFn(platform: string, fn: SendFn): void {
    this.sendFns.set(platform, fn);
  }

  /**
   * Register a custom approve action for a draft "kind" (matched on
   * `draft.context.kind`). When set, approve/approveWithEdit run this instead of
   * the per-platform channel send — used for non-message drafts like Classroom
   * homework submissions (attach + turn in on approval).
   */
  registerApproveAction(kind: string, fn: ApproveActionFn): void {
    this.approveActions.set(kind, fn);
  }

  /** Resolve a custom approve action for a draft, by its `context.kind`. */
  private approveActionFor(draft: DraftRow): ApproveActionFn | undefined {
    const kind = typeof draft.context?.kind === "string" ? draft.context.kind : "";
    return kind ? this.approveActions.get(kind) : undefined;
  }

  /**
   * Create a draft from an outgoing message.
   *
   * Flow:
   * 1. Check platform consent mode (always_ask / auto_approve / notify_only)
   * 2. For auto_approve: send immediately + FYI notification
   * 3. For always_ask: check per-contact autonomy, then create draft
   * 4. For notify_only: return null (should be handled upstream)
   */
  async createDraft(
    message: OutgoingMessage,
    userId: string,
    context: Record<string, unknown> = {},
  ): Promise<DraftRow | null> {
    // 1. Check platform consent mode
    const consentMode = await this.resolveConsentMode(message.platform);

    if (consentMode === "auto_approve") {
      return this.handleAutoApprove(message, context);
    }

    if (consentMode === "notify_only") {
      // Should not reach here (gateway intercepts), but handle gracefully
      return null;
    }

    // 2. "always_ask" -- check per-contact autonomy for backwards compat
    const autonomy = await this.resolveAutonomy(message.platform, message.channelId);

    if (autonomy === "auto") {
      return this.handleAutoApprove(message, context);
    }

    if (autonomy === "silent") {
      log.info(`Discarded message to ${message.channelId} (autonomy: silent)`);
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

    // 3. Create draft for approval
    const draft = await dbCreateDraft({
      platform: message.platform,
      channelId: message.channelId,
      threadId: message.threadId,
      userId,
      inReplyTo: message.inReplyTo,
      content: message.content,
      context,
    });

    // Notify connected clients (gRPC + WebSocket)
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

    // Post to default Slack channel with Approve/Edit/Decline buttons
    if (this.notifyDefaultChannel) {
      this.notifyDefaultChannel(draft, context).catch((err) =>
        log.error({ err }, "Failed to post to default channel"),
      );
    }

    // Send Expo push notification so the mobile app surfaces the draft.
    // Fire-and-forget — failure to push must not block draft creation.
    import("./push-notifications.ts")
      .then(({ notifyUser }) =>
        notifyUser(userId, {
          title: `Draft ready for ${message.platform}`,
          body: message.content.slice(0, 140),
          data: { draftId: draft.id, kind: "draft_created", platform: message.platform },
        }),
      )
      .catch((err) => log.warn({ err }, "Mobile push fan-out failed"));

    log.info(`Draft created: ${draft.id.slice(0, 8)} for ${userId}`);
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

    // Custom-kind drafts (e.g. Classroom submissions) run their registered action
    // instead of a channel send.
    const action = this.approveActionFor(draft);
    if (action) {
      try {
        await action(draft);
        await markDraftSent(draft.id);
        this.notifyWs?.({
          type: "system",
          subtype: "draft_approved",
          message: `Draft ${draft.id.slice(0, 8)} approved`,
          data: { draftId: draft.id, kind: draft.context?.kind },
        });
        log.info(`Draft approved (action ${String(draft.context?.kind)}): ${draft.id.slice(0, 8)}`);
        return { success: true };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log.error({ err: errMsg }, `Approve action failed for draft ${draft.id.slice(0, 8)}`);
        return { success: false, error: `Action failed: ${errMsg}` };
      }
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

      log.info(`Draft approved and sent: ${draft.id.slice(0, 8)}`);
      return { success: true };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error({ err: errMsg }, `Failed to send approved draft ${draft.id.slice(0, 8)}`);
      return { success: false, error: `Send failed: ${errMsg}` };
    }
  }

  /**
   * Approve a draft with edits: send the edited content, capture the diff for learning.
   */
  async approveWithEdit(
    draftId: string,
    editedContent: string,
  ): Promise<{ success: boolean; error?: string }> {
    const draft = await dbApproveDraft(draftId);
    if (!draft) {
      return { success: false, error: "Draft not found or already processed" };
    }

    // Custom-kind drafts (e.g. Classroom submissions): run the action with the
    // EDITED content, then capture the edit as a learning signal.
    const action = this.approveActionFor(draft);
    if (action) {
      try {
        await action(draft, editedContent);
        await markDraftSent(draft.id);
        if (editedContent !== draft.content) {
          this.captureDraftEdit(
            draft.content,
            editedContent,
            resolveMemoryUserId(draft.user_id),
          ).catch(() => {});
        }
        this.notifyWs?.({
          type: "system",
          subtype: "draft_approved",
          message: `Draft ${draft.id.slice(0, 8)} approved (edited)`,
          data: { draftId: draft.id, edited: true, kind: draft.context?.kind },
        });
        log.info(`Draft approved (edited action): ${draft.id.slice(0, 8)}`);
        return { success: true };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log.error(
          { err: errMsg },
          `Approve action (edit) failed for draft ${draft.id.slice(0, 8)}`,
        );
        return { success: false, error: `Action failed: ${errMsg}` };
      }
    }

    const sendFn = this.sendFns.get(draft.platform);
    if (!sendFn) {
      return { success: false, error: `No send function registered for ${draft.platform}` };
    }

    try {
      // Send the EDITED content, not the original draft
      log.info(
        `Sending edited draft ${draft.id.slice(0, 8)} to ${draft.platform}:${draft.channel_id}`,
      );
      await sendFn(draft.channel_id, editedContent, draft.thread_id ?? undefined);
      await markDraftSent(draft.id);

      // Capture the edit as a learning signal (fire-and-forget)
      if (editedContent !== draft.content) {
        this.captureDraftEdit(
          draft.content,
          editedContent,
          resolveMemoryUserId(draft.user_id),
        ).catch(() => {});
      }

      this.notifyWs?.({
        type: "system",
        subtype: "draft_approved",
        message: `Draft ${draft.id.slice(0, 8)} approved (edited) and sent`,
        data: { draftId: draft.id, edited: true },
      });

      log.info(`Draft approved (edited) and sent: ${draft.id.slice(0, 8)}`);
      return { success: true };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error({ err: errMsg }, `Failed to send edited draft ${draft.id.slice(0, 8)}`);
      return { success: false, error: `Send failed: ${errMsg}` };
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

    log.info(`Draft rejected: ${draft.id.slice(0, 8)}`);
    return { success: true };
  }

  // ── Private helpers ──

  /**
   * Handle auto-approve: send immediately + post FYI notification.
   */
  private async handleAutoApprove(
    message: OutgoingMessage,
    context: Record<string, unknown>,
  ): Promise<null> {
    const sendFn = this.sendFns.get(message.platform);
    if (sendFn) {
      await sendFn(message.channelId, message.content, message.threadId);
      log.info(`Auto-sent to ${message.channelId} on ${message.platform}`);

      this.notifyWs?.({
        type: "system",
        subtype: "auto_sent",
        message: `Message auto-sent on ${message.platform} to ${message.channelId}`,
        data: {
          platform: message.platform,
          channelId: message.channelId,
          preview: message.content.slice(0, 120),
        },
      });

      // FYI notification to default channel
      if (this.notifyDefaultChannelFyi) {
        this.notifyDefaultChannelFyi(
          message.platform,
          message.channelId,
          message.content,
          context,
        ).catch((err) => log.error({ err }, "Failed to post FYI to default channel"));
      }
    }
    return null;
  }

  /**
   * Resolve per-platform consent mode.
   */
  private async resolveConsentMode(platform: string): Promise<ConsentMode> {
    try {
      return await getConsentMode(platform);
    } catch {
      return "always_ask";
    }
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
      const contact = await findContactByIdentity(
        resolveMemoryUserId(undefined),
        platform,
        channelId,
      );
      if (contact) {
        return contact.autonomy;
      }
    } catch {
      // Identity graph not available or DB error
    }
    return "draft";
  }

  /**
   * Capture a draft edit as a learning signal.
   * Feeds the original -> edited diff to the knowledge extractor.
   */
  private async captureDraftEdit(original: string, edited: string, userId: string): Promise<void> {
    try {
      const { updateUserModel } = await import("../memory/user-model.ts");
      await updateUserModel(
        userId,
        {
          facts: [],
          preferences: [],
          corrections: [
            {
              original,
              corrected: edited,
              confidence: 0.9,
            },
          ],
          decisionPatterns: [],
          values: [],
        },
        [],
      );
      log.info(`Draft edit captured as learning signal`);
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : err }, "Failed to capture draft edit");
    }
  }
}
