/**
 * Ingestion pipeline types.
 *
 * An IngestSource is an async generator that yields messages from a platform.
 * The pipeline orchestrator consumes these, deduplicates, chunks, embeds, and stores them.
 */

export interface IngestMessage {
  /** Platform-specific unique ID (e.g., Slack ts, iMessage ROWID, Gmail messageId) */
  id: string;
  platform: string;
  /** Contact identifier (email, phone, Slack user ID) */
  contact: string;
  /** Human-readable contact name (if available) */
  contactName?: string;
  /** "sent" = user's own message, "received" = from others */
  direction: "sent" | "received";
  /** Channel or thread identifier */
  channelId: string;
  channelName?: string;
  threadId?: string;
  content: string;
  timestamp: Date;
  metadata?: Record<string, unknown>;
}

export interface IngestOptions {
  /** Only ingest messages after this date */
  since?: Date;
  /** Filter to a specific contact */
  contact?: string;
  /** Dry run — count messages without storing */
  dryRun?: boolean;
  /** Batch size for embedding calls */
  embeddingBatchSize?: number;
}

export interface IngestProgress {
  platform: string;
  messagesProcessed: number;
  messagesSkipped: number;
  /** Current cursor for resuming (platform-specific) */
  cursor?: string;
  /** Whether the source has finished yielding */
  done: boolean;
  error?: string;
}

export interface IngestJobRow {
  id: string;
  platform: string;
  source_type: string;
  status: "running" | "completed" | "failed" | "cancelled";
  contact: string | null;
  since_date: Date | null;
  messages_processed: number;
  messages_skipped: number;
  last_cursor: string | null;
  error: string | null;
  started_at: Date;
  finished_at: Date | null;
  last_successful_at: Date | null;
  delta_schedule: string;
  delta_enabled: boolean;
}

/**
 * An ingestion source yields messages as an async generator.
 * This allows the pipeline to process messages incrementally
 * without loading everything into memory.
 */
export interface IngestSource {
  readonly platform: string;
  readonly sourceType: string;

  /**
   * Yield messages from the source.
   * @param options - Filtering options (since date, contact, etc.)
   * @param cursor - Resume cursor from a previous run
   */
  ingest(options: IngestOptions, cursor?: string): AsyncGenerator<IngestMessage, void, undefined>;
}
