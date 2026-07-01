/**
 * Knowledge extraction from conversation turns.
 *
 * Uses a lightweight LLM call (Haiku by default) to extract structured
 * knowledge — facts, preferences, and corrections — from each conversation
 * exchange. Runs fire-and-forget after normal conversation indexing.
 */

import { createHash } from "node:crypto";
import { z } from "zod";
import { runReasoningFork } from "../sdk/reasoning-fork.ts";
import { storeMemoryChunk } from "../db/memory.ts";
import { generateEmbedding, isEmbeddingAvailable } from "./embeddings.ts";
import { loadEnvConfig } from "../config/env.ts";
import { createLogger } from "../lib/logger.ts";

const log = createLogger("extractor");

export interface ExtractedFact {
  text: string;
  entities: string[];
  confidence: number;
}

export interface ExtractedPreference {
  key: string;
  value: string;
  confidence: number;
}

export interface ExtractedCorrection {
  original: string;
  corrected: string;
  confidence: number;
}

export interface ExtractedDecisionPattern {
  principle: string;
  evidence: string[];
  context: string;
  weight: number;
  exceptions: string[];
  confidence: number;
}

export interface ExtractedValue {
  value: string;
  description: string;
  context: string;
  evidence: string[];
  confidence: number;
}

export interface ExtractedKnowledge {
  facts: ExtractedFact[];
  preferences: ExtractedPreference[];
  corrections: ExtractedCorrection[];
  decisionPatterns: ExtractedDecisionPattern[];
  values: ExtractedValue[];
}

// Phase C — JSON Schema the SDK validates the model's output against (bounded
// retry), replacing the fragile regex + JSON.parse path. Lenient: every array
// defaults to [] and confidence defaults so a partial extraction still validates.
const ExtractedKnowledgeSchema = z.object({
  facts: z
    .array(
      z.object({
        text: z.string(),
        entities: z.array(z.string()).default([]),
        confidence: z.number().default(0.6),
      }),
    )
    .default([]),
  preferences: z
    .array(
      z.object({
        key: z.string(),
        value: z.string(),
        confidence: z.number().default(0.6),
      }),
    )
    .default([]),
  corrections: z
    .array(
      z.object({
        original: z.string(),
        corrected: z.string(),
        confidence: z.number().default(0.6),
      }),
    )
    .default([]),
  decisionPatterns: z
    .array(
      z.object({
        principle: z.string(),
        evidence: z.array(z.string()).default([]),
        context: z.string().default(""),
        weight: z.number().default(0.5),
        exceptions: z.array(z.string()).default([]),
        confidence: z.number().default(0.6),
      }),
    )
    .default([]),
  values: z
    .array(
      z.object({
        value: z.string(),
        description: z.string().default(""),
        context: z.string().default(""),
        evidence: z.array(z.string()).default([]),
        confidence: z.number().default(0.6),
      }),
    )
    .default([]),
});

// STABLE instructions — the fixed rubric + JSON-shape spec, byte-identical every
// call so the SDK caches it in the system-prompt prefix. The per-turn User/Assistant
// pair is the ONLY dynamic data and is sent LAST as the fork `input`.
const EXTRACTION_INSTRUCTIONS = `You are a knowledge extraction system. Extract structured knowledge from the conversation exchange in the user message. Return ONLY valid JSON, no other text.

Extract:
- facts: things the user stated about themselves, their projects, tech stack, environment, PEOPLE (names, relationships, phone numbers, emails, roles), addresses, schedules, or any concrete personal information. ALWAYS extract contact details (phone numbers, email addresses) as separate facts with the person's name as an entity.
- preferences: user's expressed preferences for coding style, communication, tools, workflows
- corrections: cases where the user corrected the assistant's output or assumptions
- decisionPatterns: HOW the user thinks -- decision heuristics revealed when they choose between options, override suggestions, explain reasoning, or express priorities. Look for trade-off language ("more important than"), risk tolerance, prioritization patterns, and correction rationale. Each pattern should capture the underlying principle, not just the specific instance.
- values: WHAT the user values -- core principles revealed through their choices, rejections, and explanations. Look for statements about quality, speed, simplicity, thoroughness, autonomy, collaboration, etc.

IMPORTANT: When the user shares contact details (phone numbers, email addresses), extract EACH as a separate fact. Example: "Sophie - (415) 418-4370" should produce {"text": "Sophie's phone number is (415) 418-4370", "entities": ["Sophie", "(415) 418-4370"], "confidence": 0.95}

Return: {"facts": [...], "preferences": [...], "corrections": [...], "decisionPatterns": [...], "values": [...]}
Each fact: {"text": "...", "entities": ["..."], "confidence": 0.0-1.0}
Each preference: {"key": "...", "value": "...", "confidence": 0.0-1.0}
Each correction: {"original": "...", "corrected": "...", "confidence": 0.0-1.0}
Each decisionPattern: {"principle": "concise heuristic", "evidence": ["what the user said/did"], "context": "when this applies", "weight": 0.0-1.0, "exceptions": [], "confidence": 0.0-1.0}
Each value: {"value": "short label", "description": "what this means to the user", "context": "domain where observed", "evidence": ["supporting observations"], "confidence": 0.0-1.0}
Return empty arrays if nothing to extract. Only extract clear, explicit statements. Decision patterns and values require strong signals -- do not infer from weak evidence.`;

/**
 * Extract structured knowledge from a conversation turn.
 * Returns empty knowledge if extraction fails or nothing is found.
 */
export async function extractKnowledge(
  userMessage: string,
  agentResponse: string,
): Promise<ExtractedKnowledge> {
  const empty: ExtractedKnowledge = {
    facts: [],
    preferences: [],
    corrections: [],
    decisionPatterns: [],
    values: [],
  };

  // Skip short messages (greetings, commands, etc.)
  if (userMessage.length < 50) return empty;

  const config = loadEnvConfig();
  const model = config.extractionModel ?? "claude-haiku-4-5";

  // Only the dynamic per-turn pair goes in the fork input (sent LAST, uncached).
  // The rubric + JSON-shape spec lives in EXTRACTION_INSTRUCTIONS (cached prefix).
  const input = `User: ${userMessage}\nAssistant: ${agentResponse.slice(0, 2000)}`; // Truncate long responses

  try {
    // runReasoningFork carries useSubscription (authenticates on subscription-only
    // installs), forces allowedTools:[] so a pure-reasoning fork actually emits the
    // JSON, retries transient 429/529s, and reads the SDK-validated structured
    // output with one balanced-JSON fallback. maxTurns:2 for the multi-step
    // extraction. On parse failure, `data` is null → return the caller's empty
    // default (extraction stores nothing rather than a synthetic row).
    const { data } = await runReasoningFork({
      instructions: EXTRACTION_INSTRUCTIONS,
      input,
      schema: ExtractedKnowledgeSchema,
      model,
      maxTurns: 2,
      label: "knowledge-extraction",
    });

    return data ?? empty;
  } catch (err) {
    log.debug({ err }, "Knowledge extraction failed");
    return empty;
  }
}

/**
 * Extract knowledge from a conversation turn and store as categorized memory chunks.
 * Returns the IDs of stored chunks for user model accumulation.
 */
export async function extractAndStoreKnowledge(
  userId: string,
  userMessage: string,
  agentResponse: string,
  sessionKey: string,
): Promise<{ knowledge: ExtractedKnowledge; chunkIds: string[] }> {
  const knowledge = await extractKnowledge(userMessage, agentResponse);
  const chunkIds: string[] = [];
  const embeddingModel = process.env.EMBEDDING_MODEL ?? "gemini-embedding-001";

  // Store extracted facts
  for (const fact of knowledge.facts) {
    const hash = createHash("sha256").update(fact.text).digest("hex").slice(0, 16);
    const id = `fact:${userId}:${hash}`;

    let embedding: number[] | undefined;
    if (isEmbeddingAvailable()) {
      try {
        embedding = await generateEmbedding(fact.text);
      } catch {
        // Continue without embedding
      }
    }

    await storeMemoryChunk({
      id,
      userId,
      source: "conversation",
      path: sessionKey,
      text: fact.text,
      embedding,
      model: embedding ? embeddingModel : undefined,
      metadata: {
        category: "fact",
        entities: fact.entities,
        confidence: fact.confidence,
      },
    });
    chunkIds.push(id);
  }

  // Store extracted preferences
  for (const pref of knowledge.preferences) {
    const text = `Preference: ${pref.key} = ${pref.value}`;
    const hash = createHash("sha256").update(pref.key).digest("hex").slice(0, 16);
    const id = `pref:${userId}:${hash}`;

    let embedding: number[] | undefined;
    if (isEmbeddingAvailable()) {
      try {
        embedding = await generateEmbedding(text);
      } catch {
        // Continue without embedding
      }
    }

    await storeMemoryChunk({
      id,
      userId,
      source: "conversation",
      path: sessionKey,
      text,
      embedding,
      model: embedding ? embeddingModel : undefined,
      metadata: {
        category: "preference",
        confidence: pref.confidence,
      },
    });
    chunkIds.push(id);
  }

  // Store extracted corrections
  for (const corr of knowledge.corrections) {
    const text = `Correction: "${corr.original}" → "${corr.corrected}"`;
    const hash = createHash("sha256").update(text).digest("hex").slice(0, 16);
    const id = `corr:${userId}:${hash}`;

    let embedding: number[] | undefined;
    if (isEmbeddingAvailable()) {
      try {
        embedding = await generateEmbedding(text);
      } catch {
        // Continue without embedding
      }
    }

    await storeMemoryChunk({
      id,
      userId,
      source: "conversation",
      path: sessionKey,
      text,
      embedding,
      model: embedding ? embeddingModel : undefined,
      metadata: {
        category: "correction",
        confidence: corr.confidence,
      },
    });
    chunkIds.push(id);
  }

  // Store extracted decision patterns
  for (const pattern of knowledge.decisionPatterns) {
    const text = `Decision pattern: ${pattern.principle} (context: ${pattern.context})`;
    const hash = createHash("sha256").update(pattern.principle).digest("hex").slice(0, 16);
    const id = `dp:${userId}:${hash}`;

    let embedding: number[] | undefined;
    if (isEmbeddingAvailable()) {
      try {
        embedding = await generateEmbedding(text);
      } catch {
        // Continue without embedding
      }
    }

    await storeMemoryChunk({
      id,
      userId,
      source: "conversation",
      path: sessionKey,
      text,
      embedding,
      model: embedding ? embeddingModel : undefined,
      metadata: {
        category: "decision_pattern",
        principle: pattern.principle,
        evidence: pattern.evidence,
        context: pattern.context,
        weight: pattern.weight,
        exceptions: pattern.exceptions,
        confidence: pattern.confidence,
      },
    });
    chunkIds.push(id);
  }

  // Store extracted values
  for (const val of knowledge.values) {
    const text = `Value: ${val.value} -- ${val.description}`;
    const hash = createHash("sha256").update(val.value).digest("hex").slice(0, 16);
    const id = `val:${userId}:${hash}`;

    let embedding: number[] | undefined;
    if (isEmbeddingAvailable()) {
      try {
        embedding = await generateEmbedding(text);
      } catch {
        // Continue without embedding
      }
    }

    await storeMemoryChunk({
      id,
      userId,
      source: "conversation",
      path: sessionKey,
      text,
      embedding,
      model: embedding ? embeddingModel : undefined,
      metadata: {
        category: "value",
        value: val.value,
        description: val.description,
        context: val.context,
        evidence: val.evidence,
        confidence: val.confidence,
      },
    });
    chunkIds.push(id);
  }

  if (chunkIds.length > 0) {
    log.debug({ count: chunkIds.length, sessionKey }, "Stored knowledge chunks");
  }

  return { knowledge, chunkIds };
}
