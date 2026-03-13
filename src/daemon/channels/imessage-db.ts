/**
 * SQLite query helpers for ~/Library/Messages/chat.db.
 */

import Database from "better-sqlite3";

/** Apple's CoreData epoch: 2001-01-01T00:00:00Z in ms since Unix epoch. */
const APPLE_EPOCH_OFFSET = 978307200;

/** Convert Apple's nanosecond timestamp to a JS Date. */
export function appleTimestampToDate(ns: number): Date {
  const seconds = ns / 1_000_000_000;
  return new Date((seconds + APPLE_EPOCH_OFFSET) * 1000);
}

export interface ChatMessage {
  rowid: number;
  guid: string;
  text: string;
  date: number;
  handleIdentifier: string;
  chatGuid: string;
  chatIdentifier: string;
  chatDisplayName: string | null;
  /** 43 = 1:1, 45 = group */
  chatStyle: number;
}

/** Open chat.db in readonly mode. */
export function openChatDb(dbPath: string): Database.Database {
  return new Database(dbPath, { readonly: true, fileMustExist: true });
}

/** Return the current max ROWID in the message table. */
export function getMaxRowId(db: Database.Database): number {
  const row = db.prepare("SELECT MAX(ROWID) as maxId FROM message").get() as
    | { maxId: number | null }
    | undefined;
  return row?.maxId ?? 0;
}

/**
 * Query messages with ROWID > afterRowId.
 * Filters to incoming messages (is_from_me = 0), non-associated
 * (associated_message_type = 0), with non-empty text.
 */
export function queryNewMessages(db: Database.Database, afterRowId: number): ChatMessage[] {
  const stmt = db.prepare(`
    SELECT
      m.ROWID        AS rowid,
      m.guid         AS guid,
      m.text         AS text,
      m.date         AS date,
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
      AND m.is_from_me = 0
      AND m.associated_message_type = 0
      AND m.text IS NOT NULL
      AND m.text != ''
    ORDER BY m.ROWID ASC
  `);

  return stmt.all(afterRowId) as ChatMessage[];
}
