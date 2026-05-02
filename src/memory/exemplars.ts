/**
 * Exemplar Library -- few-shot personality priming.
 *
 * Curates a library of the user's most representative actual messages
 * as few-shot demonstrations, retrieved by context at inference time.
 * Storage reuses memory_chunks with metadata.exemplar = true.
 */

import { createHash } from "node:crypto";
import { storeMemoryChunk, searchMemoryByVector, searchMemoryByText } from "../db/memory.ts";
import { generateEmbedding, isEmbeddingAvailable } from "./embeddings.ts";
import { runSession } from "../sdk/session.ts";
import { loadEnvConfig } from "../config/env.ts";

/** Context tags for exemplar classification. */
export type ExemplarContext =
  | "email_formal"
  | "email_casual"
  | "slack_casual"
  | "slack_work"
  | "code_review"
  | "technical_discussion"
  | "personal"
  | "conflict_resolution"
  | "planning"
  | "general";

export interface ExemplarScore {
  text: string;
  score: number;
  context: ExemplarContext;
  reasoning: string;
}

export interface StoredExemplar {
  id: string;
  text: string;
  context: ExemplarContext;
  score: number;
  platform: string;
}

const SCORING_PROMPT = `You are an exemplar scoring system. Rate this message from the user on how "representative" it is of their personal communication style. High-scoring messages should be distinctive, show personality, and be useful as few-shot examples for mimicking this person's style.

Message: {message}
Platform: {platform}
Context: {contextHint}

Return ONLY valid JSON:
{
  "score": 0.0-1.0,
  "context": "one of: email_formal, email_casual, slack_casual, slack_work, code_review, technical_discussion, personal, conflict_resolution, planning, general",
  "reasoning": "brief explanation of why this score"
}

Scoring guide:
- 0.9-1.0: Highly distinctive, captures unique voice, great few-shot example
- 0.7-0.8: Good personality signal, characteristic phrasing
- 0.5-0.6: Average message, some personality but could be anyone
- 0.3-0.4: Generic, boilerplate, or too short to be useful
- 0.0-0.2: Noise (single word, emoji-only, automated)

Be selective -- most messages score 0.3-0.5. Only truly distinctive messages score above 0.7.`;

/**
 * Score a user message for exemplar quality.
 * Returns null if the message is too short or scoring fails.
 */
export async function scoreExemplar(
  message: string,
  platform: string,
  contextHint?: string,
): Promise<ExemplarScore | null> {
  // Skip messages that are too short or too long to be useful exemplars
  if (message.length < 30 || message.length > 2000) return null;

  const config = loadEnvConfig();
  const model = config.extractionModel ?? "claude-haiku-4-5";

  const prompt = SCORING_PROMPT.replace("{message}", message)
    .replace("{platform}", platform)
    .replace("{contextHint}", contextHint ?? "unknown");

  try {
    let fullText = "";

    const sdkQuery = runSession({
      prompt,
      model,
      systemPrompt: "You are a JSON scoring system. Output only valid JSON. No explanations.",
      permissionMode: "plan",
      maxTurns: 1,
      mcpServers: {},
    });

    for await (const msg of sdkQuery) {
      if (msg.type === "assistant") {
        for (const block of msg.message.content) {
          if (block.type === "text" && block.text) {
            fullText += block.text;
          }
        }
      }
      if (msg.type === "result" && "result" in msg) {
        fullText += msg.result;
      }
    }

    const jsonMatch = fullText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]) as {
      score: number;
      context: ExemplarContext;
      reasoning: string;
    };

    if (typeof parsed.score !== "number" || parsed.score < 0 || parsed.score > 1) return null;

    return {
      text: message,
      score: parsed.score,
      context: parsed.context ?? "general",
      reasoning: parsed.reasoning ?? "",
    };
  } catch {
    return null;
  }
}

/**
 * Store a scored exemplar as a memory chunk.
 * Only stores messages scoring above the threshold (0.6).
 */
export async function storeExemplar(
  scored: ExemplarScore,
  platform: string,
  sessionKey: string,
): Promise<string | null> {
  if (scored.score < 0.6) return null;

  const hash = createHash("sha256").update(scored.text).digest("hex").slice(0, 16);
  const id = `exemplar:${hash}`;
  const embeddingModel = process.env.EMBEDDING_MODEL ?? "gemini-embedding-001";

  let embedding: number[] | undefined;
  if (isEmbeddingAvailable()) {
    try {
      embedding = await generateEmbedding(scored.text);
    } catch {
      // Continue without embedding
    }
  }

  await storeMemoryChunk({
    id,
    source: "exemplar",
    path: sessionKey,
    text: scored.text,
    embedding,
    model: embedding ? embeddingModel : undefined,
    metadata: {
      category: "exemplar",
      exemplar: true,
      context: scored.context,
      score: scored.score,
      platform,
      reasoning: scored.reasoning,
    },
  });

  return id;
}

/**
 * Score and store a user message as a potential exemplar.
 * Fire-and-forget -- safe to call without awaiting.
 */
export async function scoreAndStoreExemplar(
  message: string,
  platform: string,
  sessionKey: string,
  contextHint?: string,
): Promise<void> {
  const scored = await scoreExemplar(message, platform, contextHint);
  if (scored) {
    await storeExemplar(scored, platform, sessionKey);
    if (scored.score >= 0.6) {
      console.debug(
        `[exemplars] Stored exemplar (score: ${scored.score}, context: ${scored.context})`,
      );
    }
  }
}

/**
 * Retrieve exemplars matching the current conversation context.
 * Returns 2-3 best-matching exemplars for few-shot priming.
 */
export async function retrieveExemplars(
  query: string,
  context?: ExemplarContext,
  limit: number = 3,
): Promise<StoredExemplar[]> {
  try {
    let results;

    if (isEmbeddingAvailable()) {
      try {
        const embedding = await generateEmbedding(query);
        results = await searchMemoryByVector(embedding, limit * 3, "exemplar");
      } catch {
        results = await searchMemoryByText(query, limit * 3, "exemplar");
      }
    } else {
      results = await searchMemoryByText(query, limit * 3, "exemplar");
    }

    // Filter by context if specified, then take top results
    let filtered = results;
    if (context) {
      const contextMatches = results.filter(
        (r) => (r.metadata as Record<string, unknown>)?.context === context,
      );
      // Fall back to all results if no context matches
      filtered = contextMatches.length > 0 ? contextMatches : results;
    }

    return filtered.slice(0, limit).map((r) => ({
      id: r.id,
      text: r.text,
      context: ((r.metadata as Record<string, unknown>)?.context as ExemplarContext) ?? "general",
      score: ((r.metadata as Record<string, unknown>)?.score as number) ?? 0,
      platform: ((r.metadata as Record<string, unknown>)?.platform as string) ?? "unknown",
    }));
  } catch (err) {
    console.debug("[exemplars] Retrieval failed:", err);
    return [];
  }
}
