/**
 * IMAP connection management for email channel adapter.
 *
 * Uses imapflow for IMAP IDLE (push notifications) and message fetching.
 * Separated from the main email adapter to stay under 500 LOC.
 */

import { ImapFlow, type FetchMessageObject } from "imapflow";
import { simpleParser, type ParsedMail } from "mailparser";

export interface ImapConfig {
  host: string;
  port: number;
  secure: boolean;
  auth: {
    user: string;
    pass?: string;
    accessToken?: string;
  };
}

export interface ParsedEmail {
  messageId: string;
  from: string;
  fromName: string;
  to: string[];
  subject: string;
  text: string;
  html: string | null;
  inReplyTo: string | null;
  references: string[];
  date: Date;
  threadId: string;
}

export class ImapClient {
  private client: ImapFlow | null = null;
  private config: ImapConfig;
  private onNewMessage: ((email: ParsedEmail) => void) | null = null;
  private idleTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(config: ImapConfig) {
    this.config = config;
  }

  async connect(onNewMessage: (email: ParsedEmail) => void): Promise<void> {
    this.onNewMessage = onNewMessage;

    this.client = new ImapFlow({
      host: this.config.host,
      port: this.config.port,
      secure: this.config.secure,
      auth: this.config.auth,
      logger: false,
    });

    await this.client.connect();
    console.log(`[email-imap] Connected to ${this.config.host}`);

    // Select INBOX and start IDLE
    const lock = await this.client.getMailboxLock("INBOX");
    try {
      // Listen for new messages
      this.client.on("exists", async (data: { count: number; prevCount: number }) => {
        if (data.count > data.prevCount) {
          await this.fetchNewMessages(data.prevCount + 1, data.count);
        }
      });
    } finally {
      lock.release();
    }

    // Start IDLE loop
    this.startIdle();
  }

  async disconnect(): Promise<void> {
    if (this.idleTimeout) {
      clearTimeout(this.idleTimeout);
      this.idleTimeout = null;
    }
    if (this.client) {
      await this.client.logout();
      this.client = null;
    }
  }

  private startIdle(): void {
    if (!this.client) return;

    // IDLE for 5 minutes, then refresh
    const idle = async () => {
      try {
        const lock = await this.client!.getMailboxLock("INBOX");
        try {
          await this.client!.idle();
        } finally {
          lock.release();
        }
      } catch (err) {
        console.warn("[email-imap] IDLE error:", err);
      }

      // Re-enter IDLE after timeout
      this.idleTimeout = setTimeout(() => idle(), 1000);
    };

    idle();
  }

  private async fetchNewMessages(fromSeq: number, toSeq: number): Promise<void> {
    if (!this.client || !this.onNewMessage) return;

    const lock = await this.client.getMailboxLock("INBOX");
    try {
      const range = `${fromSeq}:${toSeq}`;
      for await (const msg of this.client.fetch(range, {
        source: true,
        envelope: true,
        uid: true,
      })) {
        const parsed = await this.parseMessage(msg);
        if (parsed) {
          this.onNewMessage(parsed);
        }
      }
    } finally {
      lock.release();
    }
  }

  private async parseMessage(msg: FetchMessageObject): Promise<ParsedEmail | null> {
    if (!msg.source) return null;

    const parsed: ParsedMail = await simpleParser(msg.source);

    const from = parsed.from?.value[0];
    if (!from) return null;

    const to = parsed.to
      ? (Array.isArray(parsed.to) ? parsed.to : [parsed.to]).flatMap((t) =>
          t.value.map((v) => v.address ?? ""),
        )
      : [];

    // Build thread ID from References or In-Reply-To
    const references = parsed.references
      ? Array.isArray(parsed.references)
        ? parsed.references
        : [parsed.references]
      : [];
    const threadId = references[0] ?? parsed.messageId ?? `email:${msg.uid}`;

    return {
      messageId: parsed.messageId ?? `uid:${msg.uid}`,
      from: from.address ?? "",
      fromName: from.name ?? from.address ?? "",
      to,
      subject: parsed.subject ?? "",
      text: parsed.text ?? "",
      html: parsed.html || null,
      inReplyTo: parsed.inReplyTo ?? null,
      references,
      date: parsed.date ?? new Date(),
      threadId,
    };
  }
}
