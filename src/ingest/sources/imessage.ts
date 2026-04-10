/**
 * iMessage ingestion source.
 *
 * Reads from ~/Library/Messages/chat.db (macOS only).
 * Ingests both sent and received messages — the style model trains on sent only.
 * Uses ROWID as cursor for delta sync.
 */

import { homedir } from "node:os";
import { existsSync } from "node:fs";
import {
  openChatDb,
  appleTimestampToDate,
  type ChatMessage,
} from "../../daemon/channels/imessage-db.ts";
import type { IngestSource, IngestMessage, IngestOptions } from "../types.ts";

const DEFAULT_DB_PATH = `${homedir()}/Library/Messages/chat.db`;
const BATCH_SIZE = 1000;

export class IMessageIngestSource implements IngestSource {
  readonly platform = "imessage";
  readonly sourceType = "history";

  private readonly dbPath: string;

  constructor(dbPath?: string) {
    this.dbPath = dbPath ?? DEFAULT_DB_PATH;
  }

  async *ingest(
    options: IngestOptions,
    cursor?: string,
  ): AsyncGenerator<IngestMessage, void, undefined> {
    if (!existsSync(this.dbPath)) {
      throw new Error(`iMessage database not found at ${this.dbPath}. macOS only.`);
    }

    const db = openChatDb(this.dbPath);
    try {
      const afterRowId = cursor ? Number.parseInt(cursor, 10) : 0;
      const sinceTimestamp = options.since ? dateToAppleTimestamp(options.since) : null;

      let lastRowId = afterRowId;

      // Query both sent and received messages
      const stmt = db.prepare(`
        SELECT
          m.ROWID        AS rowid,
          m.guid         AS guid,
          m.text         AS text,
          m.date         AS date,
          m.is_from_me   AS isFromMe,
          h.id           AS handleIdentifier,
          c.guid         AS chatGuid,
          c.chat_identifier AS chatIdentifier,
          c.display_name AS chatDisplayName,
          c.style        AS chatStyle
        FROM message m
        JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
        JOIN chat c ON c.ROWID = cmj.chat_id
        LEFT JOIN handle h ON h.ROWID = m.handle_id
        WHERE m.ROWID > ?
          AND m.associated_message_type = 0
          AND m.text IS NOT NULL
          AND m.text != ''
          ${sinceTimestamp !== null ? "AND m.date >= ?" : ""}
        ORDER BY m.ROWID ASC
        LIMIT ?
      `);

      while (true) {
        const params: (number | string)[] = [lastRowId];
        if (sinceTimestamp !== null) params.push(sinceTimestamp);
        params.push(BATCH_SIZE);

        const rows = stmt.all(...params) as Array<ChatMessage & { isFromMe: number }>;
        if (rows.length === 0) break;

        for (const row of rows) {
          const contact = row.handleIdentifier || row.chatIdentifier || "unknown";

          // Filter by contact if specified
          if (options.contact && !contact.includes(options.contact)) continue;

          const direction = row.isFromMe ? "sent" : "received";
          const timestamp = appleTimestampToDate(row.date);

          yield {
            id: String(row.rowid),
            platform: "imessage",
            contact,
            contactName: row.chatDisplayName || undefined,
            direction: direction as "sent" | "received",
            channelId: row.chatGuid,
            channelName: row.chatDisplayName || row.chatIdentifier,
            content: row.text,
            timestamp,
            metadata: {
              guid: row.guid,
              chatStyle: row.chatStyle,
              isGroupChat: row.chatStyle === 45,
            },
          };

          lastRowId = row.rowid;
        }

        // If we got fewer than BATCH_SIZE, we're done
        if (rows.length < BATCH_SIZE) break;
      }
    } finally {
      db.close();
    }
  }
}

/** Convert a JS Date to Apple nanosecond timestamp. */
function dateToAppleTimestamp(date: Date): number {
  const APPLE_EPOCH_OFFSET = 978307200;
  const unixSeconds = date.getTime() / 1000;
  return (unixSeconds - APPLE_EPOCH_OFFSET) * 1_000_000_000;
}
