/**
 * Email channel adapter.
 *
 * Real-time inbox monitoring via IMAP IDLE with draft-and-approve for replies.
 * Sends via SMTP after approval. Config stored in the integrations table.
 */

import { randomUUID } from "node:crypto";
import type { ChannelAdapter, IncomingMessage, OutgoingMessage } from "../types.ts";
import type { DraftManager } from "../draft-manager.ts";
import { ImapClient, type ImapConfig, type ParsedEmail } from "./email-imap.ts";
import { SmtpClient, type SmtpConfig } from "./email-smtp.ts";

export interface EmailAdapterOptions {
  imap: ImapConfig;
  smtp: SmtpConfig;
  userEmail: string;
  onMessage: (msg: IncomingMessage) => void;
  draftManager: DraftManager;
}

export class EmailAdapter implements ChannelAdapter {
  readonly platform = "email";

  private imapClient: ImapClient;
  private smtpClient: SmtpClient;
  private userEmail: string;
  private onMessage: (msg: IncomingMessage) => void;
  private draftManager: DraftManager;

  // Track threads for context
  private threadSubjects = new Map<string, string>();
  // Cache last incoming context per channel for draft notifications
  private lastIncomingContext = new Map<string, Record<string, unknown>>();

  constructor(options: EmailAdapterOptions) {
    this.imapClient = new ImapClient(options.imap);
    this.smtpClient = new SmtpClient(options.smtp);
    this.userEmail = options.userEmail;
    this.onMessage = options.onMessage;
    this.draftManager = options.draftManager;
  }

  async start(): Promise<void> {
    // Connect SMTP for sending
    await this.smtpClient.connect();

    // Connect IMAP and start listening
    await this.imapClient.connect((email) => this.handleIncomingEmail(email));

    // Register send function with DraftManager
    this.draftManager.registerSendFn("email", async (channelId, text, threadId) => {
      const subject = this.threadSubjects.get(threadId ?? "") ?? "Re: ";
      await this.smtpClient.send({
        to: channelId, // channelId is the recipient email
        subject,
        text,
        inReplyTo: threadId,
        references: threadId ? [threadId] : undefined,
      });
    });

    console.log(`[email-adapter] Running (${this.userEmail})`);
  }

  async stop(): Promise<void> {
    await this.imapClient.disconnect();
    this.smtpClient.disconnect();
  }

  async send(message: OutgoingMessage): Promise<void> {
    // Route through DraftManager for approve-before-send
    const cachedCtx = this.lastIncomingContext.get(message.channelId) ?? {};
    await this.draftManager.createDraft(message, this.userEmail, {
      channelId: message.channelId,
      threadId: message.threadId,
      ...cachedCtx,
    });
    this.lastIncomingContext.delete(message.channelId);
  }

  private handleIncomingEmail(email: ParsedEmail): void {
    // Skip emails from self
    if (email.from === this.userEmail) return;

    // Track thread subject for replies
    if (email.threadId) {
      this.threadSubjects.set(email.threadId, `Re: ${email.subject}`);
    }

    // Strip HTML, use plain text
    const content = email.text || stripHtmlBasic(email.html ?? "");
    if (!content.trim()) return;

    const incoming: IncomingMessage = {
      id: email.messageId || randomUUID(),
      platform: "email",
      channelId: email.from, // Reply-to address
      userId: email.from,
      threadId: email.threadId,
      content: `From: ${email.fromName} <${email.from}>\nSubject: ${email.subject}\n\n${content}`,
      timestamp: email.date,
      metadata: {
        subject: email.subject,
        to: email.to,
        inReplyTo: email.inReplyTo,
        references: email.references,
      },
    };

    // Cache incoming context for draft notifications
    this.lastIncomingContext.set(email.from, {
      senderName: email.fromName || email.from,
      messageType: "dm",
      originalMessage: `Subject: ${email.subject}\n\n${content}`,
    });

    this.onMessage(incoming);
  }
}

function stripHtmlBasic(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
