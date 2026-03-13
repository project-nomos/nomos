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
import type { IncomingMessage, OutgoingMessage } from "./types.ts";

/**
 * Index a conversation turn (user message + agent response) into vector memory.
 * Safe to call fire-and-forget — logs errors but never throws.
 */
export async function indexConversationTurn(
  incoming: IncomingMessage,
  outgoing: OutgoingMessage,
): Promise<void> {
  const sessionKey = `${incoming.platform}:${incoming.channelId}`;
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
      console.debug("[memory-indexer] Embedding generation failed, storing text-only:", err);
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

  console.debug(`[memory-indexer] Indexed ${chunks.length} chunk(s) from ${sessionKey}`);
}
