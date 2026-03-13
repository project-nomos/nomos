/**
 * Chat.db watcher + poller for receiving iMessages.
 *
 * Uses chokidar to watch the WAL file for near-instant detection,
 * with a fallback poll timer in case file-system events are missed.
 */

import * as path from "node:path";
import * as os from "node:os";
import { watch, type FSWatcher } from "chokidar";
import { openChatDb, getMaxRowId, queryNewMessages, type ChatMessage } from "./imessage-db.ts";
import type Database from "better-sqlite3";

const POLL_INTERVAL_MS = 5_000;
const DEBOUNCE_MS = 200;

export type NewMessageCallback = (msg: ChatMessage) => void;

export class IMessageReceiver {
  private db: Database.Database | null = null;
  private watcher: FSWatcher | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private highWaterMark = 0;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private onNewMessage: NewMessageCallback;
  private dbPath: string;

  constructor(onNewMessage: NewMessageCallback, dbPath?: string) {
    this.onNewMessage = onNewMessage;
    this.dbPath = dbPath ?? path.join(os.homedir(), "Library", "Messages", "chat.db");
  }

  /** Open chat.db, set high water mark, start watching. */
  start(): void {
    this.db = openChatDb(this.dbPath);
    this.highWaterMark = getMaxRowId(this.db);
    console.log(`[imessage-receiver] Opened chat.db, starting from ROWID ${this.highWaterMark}`);

    // Watch WAL file for near-instant detection
    const walPath = this.dbPath + "-wal";
    this.watcher = watch(walPath, {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: false,
    });
    this.watcher.on("change", () => this.debouncedPoll());
    this.watcher.on("add", () => this.debouncedPoll());

    // Fallback poll timer
    this.pollTimer = setInterval(() => this.poll(), POLL_INTERVAL_MS);
  }

  /** Stop watching, clear timers, close db. */
  stop(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  /** Debounce WAL change events to avoid rapid-fire queries. */
  private debouncedPoll(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.poll(), DEBOUNCE_MS);
  }

  /** Query for new messages and advance the high water mark. */
  private poll(): void {
    if (!this.db) return;

    try {
      const messages = queryNewMessages(this.db, this.highWaterMark);
      for (const msg of messages) {
        if (msg.rowid > this.highWaterMark) {
          this.highWaterMark = msg.rowid;
        }
        this.onNewMessage(msg);
      }
    } catch (err) {
      // Database may be temporarily locked during writes; retry next cycle
      console.warn("[imessage-receiver] Poll error:", err);
    }
  }
}
