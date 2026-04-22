/**
 * Knowledge extraction from conversation turns.
 *
 * Uses a lightweight LLM call (Haiku by default) to extract structured
 * knowledge — facts, preferences, and corrections — from each conversation
 * exchange. Runs fire-and-forget after normal conversation indexing.
 */

import { createHash } from "node:crypto";
import { runSession } from "../sdk/session.ts";
import { storeMemoryChunk } from "../db/memory.ts";
import { generateEmbedding, isEmbeddingAvailable } from "./embeddings.ts";
import { loadEnvConfig } from "../config/env.ts";

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

const EXTRACTION_PROMPT = `You are a knowledge extraction system. Extract structured knowledge from this conversation exchange. Return ONLY valid JSON, no other text.

User: {userMessage}
Assistant: {agentResponse}

Extract:
- facts: things the user stated about themselves, their projects, tech stack, environment
- preferences: user's expressed preferences for coding style, communication, tools, workflows
- corrections: cases where the user corrected the assistant's output or assumptions
- decisionPatterns: HOW the user thinks -- decision heuristics revealed when they choose between options, override suggestions, explain reasoning, or express priorities. Look for trade-off language ("more important than"), risk tolerance, prioritization patterns, and correction rationale. Each pattern should capture the underlying principle, not just the specific instance.
- values: WHAT the user values -- core principles revealed through their choices, rejections, and explanations. Look for statements about quality, speed, simplicity, thoroughness, autonomy, collaboration, etc.

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

  const prompt = EXTRACTION_PROMPT.replace("{userMessage}", userMessage).replace(
    "{agentResponse}",
    agentResponse.slice(0, 2000),
  ); // Truncate long responses

  try {
    let fullText = "";

    const sdkQuery = runSession({
      prompt,
      model,
      systemPrompt: "You are a JSON extraction system. Output only valid JSON. No explanations.",
      permissionMode: "plan", // Prevents tool execution
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
      if (msg.type === "result") {
        for (const block of msg.result) {
          if ((block as { type: string; text?: string }).type === "text") {
            fullText += (block as { type: string; text: string }).text;
          }
        }
      }
    }

    // Extract JSON from response (handle markdown code blocks)
    const jsonMatch = fullText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return empty;

    let parsed: ExtractedKnowledge;
    try {
      parsed = JSON.parse(jsonMatch[0]) as ExtractedKnowledge;
    } catch {
      // LLM returned non-JSON text -- silently skip
      return empty;
    }

    // Validate structure
    return {
      facts: Array.isArray(parsed.facts) ? parsed.facts : [],
      preferences: Array.isArray(parsed.preferences) ? parsed.preferences : [],
      corrections: Array.isArray(parsed.corrections) ? parsed.corrections : [],
      decisionPatterns: Array.isArray(parsed.decisionPatterns) ? parsed.decisionPatterns : [],
      values: Array.isArray(parsed.values) ? parsed.values : [],
    };
  } catch (err) {
    console.debug("[extractor] Knowledge extraction failed:", err);
    return empty;
  }
}

/**
 * Extract knowledge from a conversation turn and store as categorized memory chunks.
 * Returns the IDs of stored chunks for user model accumulation.
 */
export async function extractAndStoreKnowledge(
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
    const id = `fact:${hash}`;

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
    const id = `pref:${hash}`;

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
    const id = `corr:${hash}`;

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
    const id = `dp:${hash}`;

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
    const id = `val:${hash}`;

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
    console.debug(`[extractor] Stored ${chunkIds.length} knowledge chunk(s) from ${sessionKey}`);
  }

  return { knowledge, chunkIds };
}
