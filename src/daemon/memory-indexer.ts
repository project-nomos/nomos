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
    const docHash = createHash("sha256").update(text).digest("hex").slice(0, 16);

    await storeMemoryChunk({
      id: `conv:${docHash}:${i}`,
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

  // Adaptive memory: extract structured knowledge and score exemplars (fire-and-forget)
  const config = loadEnvConfig();
  if (config.adaptiveMemory) {
    extractAndStoreKnowledgeFromTurn(incoming, outgoing, sessionKey).catch((err) => {
      log.debug({ err }, "Knowledge extraction failed");
    });

    // Score user message as a potential exemplar for few-shot personality priming
    scoreExemplarFromTurn(incoming, sessionKey).catch((err) => {
      log.debug({ err }, "Exemplar scoring failed");
    });
  }
}

/**
 * Extract structured knowledge from a conversation turn and update the user model.
 * Called fire-and-forget after normal indexing when adaptive memory is enabled.
 */
async function extractAndStoreKnowledgeFromTurn(
  incoming: IncomingMessage,
  outgoing: OutgoingMessage,
  sessionKey: string,
): Promise<void> {
  const { extractAndStoreKnowledge } = await import("../memory/extractor.ts");
  const { updateUserModel } = await import("../memory/user-model.ts");

  const { knowledge, chunkIds } = await extractAndStoreKnowledge(
    incoming.content,
    outgoing.content,
    sessionKey,
  );

  if (chunkIds.length > 0) {
    await updateUserModel(knowledge, chunkIds);

    // Promote extracted facts into the knowledge graph (Phase 2 self-wiring).
    // Scope to the CONVERSATION's user, not the indexer's system tenant, so
    // each person's brain stays private. Fire-and-forget; never blocks.
    try {
      const { ingestKnowledgeIntoGraph } = await import("../memory/graph-writer.ts");
      const ctx = {
        orgId: process.env.NOMOS_ORG_ID ?? "local",
        userId: incoming.userId || "local",
      };
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
async function scoreExemplarFromTurn(incoming: IncomingMessage, sessionKey: string): Promise<void> {
  if (incoming.content.length < 30) return;

  const { scoreAndStoreExemplar } = await import("../memory/exemplars.ts");
  await scoreAndStoreExemplar(incoming.content, incoming.platform, sessionKey);
}
