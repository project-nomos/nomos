/**
 * Automatic conversation memory indexer.
 *
 * After each completed agent turn, formats the exchange (user message +
 * agent response) as a text document, chunks it, generates embeddings,
 * and stores it in the memory_chunks table with source "conversation".
 *
 * Runs fire-and-forget so it never delays message delivery.
 */

import { createHash } from "node:crypto";
import { chunkText } from "../memory/chunker.ts";
import { precompress } from "../memory/compressor.ts";
import { generateEmbeddings, isEmbeddingAvailable } from "../memory/embeddings.ts";
import { storeMemoryChunk } from "../db/memory.ts";
import { loadEnvConfig } from "../config/env.ts";
import { resolveMemoryUserId } from "../auth/tenant-context.ts";
import { traceMemory } from "../memory/trace.ts";
import type { IncomingMessage, OutgoingMessage } from "./types.ts";
import { createLogger } from "../lib/logger.ts";

const log = createLogger("memory-indexer");

/**
 * Ephemeral ("off the record") sessions are never auto-remembered: no vector
 * indexing, no knowledge extraction, no exemplar scoring. The convention is a
 * session key with an `ephemeral` segment (e.g. `mobile:ephemeral:<id>`), which
 * a client opens when the user wants an incognito conversation. The deliberate
 * memory tools still work if the agent explicitly chooses to write; this only
 * suppresses the automatic capture path.
 */
export function isEphemeralSession(sessionKey: string): boolean {
  return /(^|:)ephemeral(:|$)/.test(sessionKey);
}

/**
 * Index a conversation turn (user message + agent response) into vector memory.
 * Safe to call fire-and-forget — logs errors but never throws.
 */
export async function indexConversationTurn(
  incoming: IncomingMessage,
  outgoing: OutgoingMessage,
): Promise<void> {
  const sessionKey = `${incoming.platform}:${incoming.channelId}`;
  if (isEphemeralSession(sessionKey)) {
    log.debug(`Skipping ephemeral session ${sessionKey} (off the record)`);
    return;
  }
  // Resolve the durable-memory owner: power-user collapses every channel to
  // 'local'; hosted keeps the authenticated user (synthetic ids fold to the
  // instance owner). This is the user_id every chunk for this turn is stamped with.
  const userId = resolveMemoryUserId(incoming.userId);
  const timestamp = incoming.timestamp.toISOString();

  // Format the exchange as a structured text block
  const text = [
    `[${timestamp}] User (${sessionKey}):`,
    incoming.content,
    "",
    "Nomos:",
    outgoing.content,
  ].join("\n");

  if (text.trim().length === 0) return;

  // Pre-compress to reduce token usage before chunking/embedding
  const compressed = precompress(text);
  if (compressed.length === 0) return;

  const chunks = chunkText(compressed);
  if (chunks.length === 0) return;

  // Generate embeddings if available, otherwise store text-only (FTS still works)
  let embeddings: number[][] | undefined;
  if (isEmbeddingAvailable()) {
    try {
      embeddings = await generateEmbeddings(chunks.map((c) => c.text));
    } catch (err) {
      log.debug({ err }, "Embedding generation failed, storing text-only");
    }
  }

  const embeddingModel = process.env.EMBEDDING_MODEL ?? "gemini-embedding-001";

  // Store each chunk
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const chunkHash = createHash("sha256").update(chunk.text).digest("hex").slice(0, 16);
    // Fold userId into the doc hash so two users' identical exchanges never
    // collide on the primary key (and overwrite each other).
    const docHash = createHash("sha256").update(`${userId}:${text}`).digest("hex").slice(0, 16);

    await storeMemoryChunk({
      id: `conv:${docHash}:${i}`,
      userId,
      source: "conversation",
      path: sessionKey,
      text: chunk.text,
      embedding: embeddings?.[i],
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      hash: chunkHash,
      model: embeddings?.[i] ? embeddingModel : undefined,
    });
  }

  log.debug(`Indexed ${chunks.length} chunk(s) from ${sessionKey}`);
  traceMemory({ op: "write_chunk", userId, ref: sessionKey, writeCount: chunks.length });

  // Adaptive memory: extract structured knowledge and score exemplars (fire-and-forget)
  const config = loadEnvConfig();
  if (config.adaptiveMemory) {
    extractAndStoreKnowledgeFromTurn(incoming, outgoing, sessionKey, userId).catch((err) => {
      log.debug({ err }, "Knowledge extraction failed");
    });

    // Score user message as a potential exemplar for few-shot personality priming
    scoreExemplarFromTurn(incoming, sessionKey, userId).catch((err) => {
      log.debug({ err }, "Exemplar scoring failed");
    });
  }

  // Commitment tracking: extract promises/follow-ups from the turn and store them
  // for deadline reminders. Separate opt-in flag (default off) since it adds its
  // own LLM call -- don't piggyback on adaptiveMemory (which defaults on).
  if (config.commitmentTracking) {
    extractAndStoreCommitmentsFromTurn(incoming, outgoing, userId).catch((err) => {
      log.debug({ err }, "Commitment extraction failed");
    });
  }
}

/**
 * Extract commitments from a conversation turn and store them for reminders.
 * Fire-and-forget; gated on config.commitmentTracking by the caller.
 */
async function extractAndStoreCommitmentsFromTurn(
  incoming: IncomingMessage,
  outgoing: OutgoingMessage,
  userId: string,
): Promise<void> {
  const { extractCommitments, storeCommitments } =
    await import("../proactive/commitment-tracker.ts");
  const commitments = await extractCommitments(incoming.content, outgoing.content);
  if (commitments.length === 0) return;
  await storeCommitments(userId, commitments, incoming.content.slice(0, 500));
  log.debug(`Stored ${commitments.length} commitment(s) for ${userId}`);
}

/**
 * Extract structured knowledge from a conversation turn and update the user model.
 * Called fire-and-forget after normal indexing when adaptive memory is enabled.
 */
async function extractAndStoreKnowledgeFromTurn(
  incoming: IncomingMessage,
  outgoing: OutgoingMessage,
  sessionKey: string,
  userId: string,
): Promise<void> {
  const { extractAndStoreKnowledge } = await import("../memory/extractor.ts");
  const { updateUserModel } = await import("../memory/user-model.ts");

  const { knowledge, chunkIds } = await extractAndStoreKnowledge(
    userId,
    incoming.content,
    outgoing.content,
    sessionKey,
  );

  if (chunkIds.length > 0) {
    await updateUserModel(userId, knowledge, chunkIds);

    // Promote extracted facts into the knowledge graph (Phase 2 self-wiring).
    // Scope to the resolved conversation owner so each person's brain stays
    // private. Fire-and-forget; never blocks.
    try {
      const { ingestKnowledgeIntoGraph } = await import("../memory/graph-writer.ts");
      const ctx = { orgId: process.env.NOMOS_ORG_ID ?? "local", userId };
      await ingestKnowledgeIntoGraph(ctx, knowledge, { sourceIds: chunkIds });
    } catch (err) {
      log.debug({ err }, "Graph ingestion failed");
    }
  }
}

/**
 * Score a user message as a potential exemplar for few-shot personality priming.
 * Only scores messages long enough to be useful (>= 30 chars).
 */
async function scoreExemplarFromTurn(
  incoming: IncomingMessage,
  sessionKey: string,
  userId: string,
): Promise<void> {
  if (incoming.content.length < 30) return;

  const { scoreAndStoreExemplar } = await import("../memory/exemplars.ts");
  await scoreAndStoreExemplar(userId, incoming.content, incoming.platform, sessionKey);
}
