/**
 * Ingestion pipeline orchestrator.
 *
 * Consumes messages from an IngestSource, deduplicates them,
 * chunks the text, generates embeddings, and stores into memory_chunks.
 */

import { randomUUID } from "node:crypto";
import { chunkText } from "../memory/chunker.ts";
import { generateEmbeddings, isEmbeddingAvailable } from "../memory/embeddings.ts";
import { storeMemoryChunk } from "../db/memory.ts";
import { getDb } from "../db/client.ts";
import { deduplicateBatch } from "./dedup.ts";
import type {
  IngestSource,
  IngestOptions,
  IngestProgress,
  IngestMessage,
  IngestJobRow,
} from "./types.ts";

const DEFAULT_BATCH_SIZE = 50;
const EMBEDDING_BATCH_SIZE = 250;

export interface PipelineCallbacks {
  onProgress?: (progress: IngestProgress) => void;
  onError?: (error: Error) => void;
}

/**
 * Run the ingestion pipeline for a given source.
 * Returns the final progress state.
 */
export async function runIngestionPipeline(
  source: IngestSource,
  options: IngestOptions = {},
  callbacks?: PipelineCallbacks,
): Promise<IngestProgress> {
  const jobId = await createIngestJob(source.platform, source.sourceType, options);

  const progress: IngestProgress = {
    platform: source.platform,
    messagesProcessed: 0,
    messagesSkipped: 0,
    done: false,
  };

  // Load last cursor from previous runs
  const lastCursor = await getLastCursor(
    source.platform,
    source.sourceType,
    options.contact ?? null,
  );

  try {
    let batch: IngestMessage[] = [];
    const batchSize = options.embeddingBatchSize ?? DEFAULT_BATCH_SIZE;

    for await (const message of source.ingest(options, lastCursor ?? undefined)) {
      batch.push(message);

      if (batch.length >= batchSize) {
        await processBatch(batch, options.dryRun ?? false, progress);
        batch = [];

        // Update job progress
        await updateIngestJobProgress(jobId, progress);
        callbacks?.onProgress?.(progress);
      }
    }

    // Process remaining messages
    if (batch.length > 0) {
      await processBatch(batch, options.dryRun ?? false, progress);
    }

    progress.done = true;
    await completeIngestJob(jobId, progress);
    callbacks?.onProgress?.(progress);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    progress.error = error.message;
    await failIngestJob(jobId, error.message, progress);
    callbacks?.onError?.(error);
  }

  return progress;
}

/** Process a batch of messages through dedup → chunk → embed → store. */
async function processBatch(
  messages: IngestMessage[],
  dryRun: boolean,
  progress: IngestProgress,
): Promise<void> {
  // Deduplicate against existing memory
  const unique = await deduplicateBatch(messages);
  progress.messagesSkipped += messages.length - unique.length;

  if (dryRun || unique.length === 0) {
    progress.messagesProcessed += unique.length;
    return;
  }

  // Chunk and prepare for embedding
  const chunkEntries: Array<{
    chunkId: string;
    text: string;
    hash: string;
    message: IngestMessage;
    startLine: number;
    endLine: number;
  }> = [];

  for (const { message, hash } of unique) {
    const formatted = formatMessageForStorage(message);
    const chunks = chunkText(formatted);

    for (const chunk of chunks) {
      chunkEntries.push({
        chunkId: randomUUID(),
        text: chunk.text,
        hash,
        message,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
      });
    }
  }

  // Generate embeddings in batches
  let embeddings: number[][] | null = null;
  if (isEmbeddingAvailable() && chunkEntries.length > 0) {
    const texts = chunkEntries.map((e) => e.text);
    embeddings = [];
    for (let i = 0; i < texts.length; i += EMBEDDING_BATCH_SIZE) {
      const batch = texts.slice(i, i + EMBEDDING_BATCH_SIZE);
      const batchEmbeddings = await generateEmbeddings(batch);
      embeddings.push(...batchEmbeddings);
    }
  }

  // Store chunks
  for (let i = 0; i < chunkEntries.length; i++) {
    const entry = chunkEntries[i];
    await storeMemoryChunk({
      id: entry.chunkId,
      source: "ingest",
      path: `${entry.message.platform}/${entry.message.channelId}`,
      text: entry.text,
      embedding: embeddings?.[i],
      startLine: entry.startLine,
      endLine: entry.endLine,
      hash: entry.hash,
      metadata: {
        source: "ingest",
        platform: entry.message.platform,
        direction: entry.message.direction,
        contact: entry.message.contact,
        contactName: entry.message.contactName,
        channelId: entry.message.channelId,
        channelName: entry.message.channelName,
        threadId: entry.message.threadId,
        timestamp: entry.message.timestamp.toISOString(),
      },
    });
  }

  // Track last message timestamp as cursor
  const lastMsg = messages[messages.length - 1];
  if (lastMsg) {
    progress.cursor = lastMsg.id;
  }

  progress.messagesProcessed += unique.length;
}

/** Format a message for chunking/embedding. */
function formatMessageForStorage(msg: IngestMessage): string {
  const direction = msg.direction === "sent" ? "Me" : (msg.contactName ?? msg.contact);
  const ts = msg.timestamp.toISOString().slice(0, 19).replace("T", " ");
  const channel = msg.channelName ?? msg.channelId;
  return `[${ts}] [${msg.platform}/${channel}] ${direction}: ${msg.content}`;
}

// --- Ingest job DB operations ---

async function createIngestJob(
  platform: string,
  sourceType: string,
  options: IngestOptions,
): Promise<string> {
  const sql = getDb();
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO ingest_jobs (platform, source_type, status, contact, since_date)
    VALUES (${platform}, ${sourceType}, 'running', ${options.contact ?? null}, ${options.since ?? null})
    ON CONFLICT (platform, source_type, contact)
    DO UPDATE SET
      status = 'running',
      started_at = now(),
      error = NULL,
      finished_at = NULL
    RETURNING id
  `;
  return row.id;
}

async function updateIngestJobProgress(jobId: string, progress: IngestProgress): Promise<void> {
  const sql = getDb();
  await sql`
    UPDATE ingest_jobs
    SET messages_processed = ${progress.messagesProcessed},
        messages_skipped = ${progress.messagesSkipped},
        last_cursor = ${progress.cursor ?? null}
    WHERE id = ${jobId}
  `;
}

async function completeIngestJob(jobId: string, progress: IngestProgress): Promise<void> {
  const sql = getDb();
  await sql`
    UPDATE ingest_jobs
    SET status = 'completed',
        messages_processed = ${progress.messagesProcessed},
        messages_skipped = ${progress.messagesSkipped},
        last_cursor = ${progress.cursor ?? null},
        finished_at = now(),
        last_successful_at = now()
    WHERE id = ${jobId}
  `;
}

async function failIngestJob(
  jobId: string,
  error: string,
  progress: IngestProgress,
): Promise<void> {
  const sql = getDb();
  await sql`
    UPDATE ingest_jobs
    SET status = 'failed',
        messages_processed = ${progress.messagesProcessed},
        messages_skipped = ${progress.messagesSkipped},
        last_cursor = ${progress.cursor ?? null},
        error = ${error},
        finished_at = now()
    WHERE id = ${jobId}
  `;
}

async function getLastCursor(
  platform: string,
  sourceType: string,
  contact: string | null,
): Promise<string | null> {
  const sql = getDb();
  const rows = await sql<{ last_cursor: string | null }[]>`
    SELECT last_cursor FROM ingest_jobs
    WHERE platform = ${platform}
      AND source_type = ${sourceType}
      AND contact IS NOT DISTINCT FROM ${contact}
      AND status = 'completed'
    ORDER BY last_successful_at DESC
    LIMIT 1
  `;
  return rows[0]?.last_cursor ?? null;
}

/** List all ingest jobs. */
export async function listIngestJobs(): Promise<IngestJobRow[]> {
  const sql = getDb();
  return sql<IngestJobRow[]>`
    SELECT * FROM ingest_jobs
    ORDER BY started_at DESC
  `;
}

/** Get a single ingest job by platform. */
export async function getIngestJobByPlatform(
  platform: string,
  sourceType: string,
): Promise<IngestJobRow | null> {
  const sql = getDb();
  const rows = await sql<IngestJobRow[]>`
    SELECT * FROM ingest_jobs
    WHERE platform = ${platform} AND source_type = ${sourceType}
    ORDER BY started_at DESC
    LIMIT 1
  `;
  return rows[0] ?? null;
}
