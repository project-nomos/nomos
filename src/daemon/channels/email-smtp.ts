/**
 * SMTP sending for email channel adapter.
 *
 * Uses nodemailer for sending emails after draft approval.
 */

import { createTransport, type Transporter } from "nodemailer";

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  auth: {
    user: string;
    pass?: string;
  };
  from: string;
}

export class SmtpClient {
  private transporter: Transporter | null = null;
  private config: SmtpConfig;

  constructor(config: SmtpConfig) {
    this.config = config;
  }

  async connect(): Promise<void> {
    this.transporter = createTransport({
      host: this.config.host,
      port: this.config.port,
      secure: this.config.secure,
      auth: {
        user: this.config.auth.user,
        pass: this.config.auth.pass,
      },
    });

    // Verify connection
    await this.transporter.verify();
    console.log(`[email-smtp] Connected to ${this.config.host}`);
  }

  async send(opts: {
    to: string;
    subject: string;
    text: string;
    inReplyTo?: string;
    references?: string[];
  }): Promise<string> {
    if (!this.transporter) {
      throw new Error("SMTP not connected");
    }

    const info = await this.transporter.sendMail({
      from: this.config.from,
      to: opts.to,
      subject: opts.subject,
      text: opts.text,
      inReplyTo: opts.inReplyTo,
      references: opts.references?.join(" "),
    });

    console.log(`[email-smtp] Sent to ${opts.to}: ${info.messageId}`);
    return info.messageId;
  }

  disconnect(): void {
    if (this.transporter) {
      this.transporter.close();
      this.transporter = null;
    }
  }
}
