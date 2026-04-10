/**
 * WhatsApp ingestion source.
 *
 * Parses standard WhatsApp .txt export files.
 * Format: "MM/DD/YY, HH:MM - Name: Message"
 * or:     "DD/MM/YYYY, HH:MM - Name: Message"
 * Ingests both sent and received messages.
 */

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { IngestSource, IngestMessage, IngestOptions } from "../types.ts";

// WhatsApp export line patterns
const LINE_PATTERN_US =
  /^\[?(\d{1,2}\/\d{1,2}\/\d{2,4}),?\s+(\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AP]M)?)\]?\s*-\s*(.+?):\s(.+)$/;
const MULTILINE_CONTINUATION = /^(?!\[?\d{1,2}\/\d{1,2}\/\d{2,4})/;

export class WhatsAppIngestSource implements IngestSource {
  readonly platform = "whatsapp";
  readonly sourceType = "export";

  private readonly filePath: string;
  private readonly userName: string;

  /**
   * @param filePath - Path to the WhatsApp .txt export file
   * @param userName - The user's display name in the export (to determine sent vs received)
   */
  constructor(filePath: string, userName: string) {
    this.filePath = filePath;
    this.userName = userName;
  }

  async *ingest(options: IngestOptions): AsyncGenerator<IngestMessage, void, undefined> {
    const rl = createInterface({
      input: createReadStream(this.filePath, { encoding: "utf-8" }),
      crlfDelay: Number.POSITIVE_INFINITY,
    });

    let currentMessage: {
      date: string;
      time: string;
      sender: string;
      content: string;
      lineNum: number;
    } | null = null;
    let lineNum = 0;

    for await (const line of rl) {
      lineNum++;

      const match = LINE_PATTERN_US.exec(line);
      if (match) {
        // Yield the previous message if we have one
        if (currentMessage) {
          const msg = this.toIngestMessage(currentMessage, options);
          if (msg) yield msg;
        }

        currentMessage = {
          date: match[1],
          time: match[2],
          sender: match[3],
          content: match[4],
          lineNum,
        };
      } else if (currentMessage && MULTILINE_CONTINUATION.test(line)) {
        // Continuation of previous message
        currentMessage.content += "\n" + line;
      }
      // Skip system messages (no sender match)
    }

    // Yield the last message
    if (currentMessage) {
      const msg = this.toIngestMessage(currentMessage, options);
      if (msg) yield msg;
    }
  }

  private toIngestMessage(
    parsed: { date: string; time: string; sender: string; content: string; lineNum: number },
    options: IngestOptions,
  ): IngestMessage | null {
    // Skip media messages
    if (parsed.content === "<Media omitted>" || parsed.content === "image omitted") {
      return null;
    }

    const timestamp = this.parseTimestamp(parsed.date, parsed.time);
    if (!timestamp || Number.isNaN(timestamp.getTime())) return null;

    // Apply since filter
    if (options.since && timestamp < options.since) return null;

    const isSent = parsed.sender === this.userName;

    // Apply contact filter
    if (options.contact && !parsed.sender.toLowerCase().includes(options.contact.toLowerCase())) {
      return null;
    }

    return {
      id: `whatsapp:${parsed.lineNum}`,
      platform: "whatsapp",
      contact: isSent ? parsed.sender : parsed.sender,
      contactName: parsed.sender,
      direction: isSent ? "sent" : "received",
      channelId: this.filePath,
      channelName: this.extractChatName(),
      content: parsed.content,
      timestamp,
    };
  }

  private parseTimestamp(dateStr: string, timeStr: string): Date | null {
    try {
      // Handle both M/D/YY and DD/MM/YYYY formats
      const parts = dateStr.split("/");
      if (parts.length !== 3) return null;

      let month: number;
      let day: number;
      let year: number;

      if (parts[2].length === 4) {
        // DD/MM/YYYY format
        day = Number.parseInt(parts[0], 10);
        month = Number.parseInt(parts[1], 10) - 1;
        year = Number.parseInt(parts[2], 10);
      } else {
        // M/D/YY format
        month = Number.parseInt(parts[0], 10) - 1;
        day = Number.parseInt(parts[1], 10);
        year = 2000 + Number.parseInt(parts[2], 10);
      }

      // Parse time
      const timeParts = timeStr.replace(/\s*[AP]M/i, "").split(":");
      let hours = Number.parseInt(timeParts[0], 10);
      const minutes = Number.parseInt(timeParts[1], 10);

      if (/PM/i.test(timeStr) && hours !== 12) hours += 12;
      if (/AM/i.test(timeStr) && hours === 12) hours = 0;

      return new Date(year, month, day, hours, minutes);
    } catch {
      return null;
    }
  }

  private extractChatName(): string {
    // Extract chat name from file path (e.g., "WhatsApp Chat with John.txt")
    const filename = this.filePath.split("/").pop() ?? this.filePath;
    const match = /WhatsApp Chat with (.+)\.txt$/i.exec(filename);
    return match?.[1] ?? filename;
  }
}
