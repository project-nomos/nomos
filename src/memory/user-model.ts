/**
 * User model aggregation logic.
 *
 * Processes extracted knowledge into accumulated user model entries.
 * Handles confidence updates: repeated confirmations increase confidence,
 * contradictions decrease it.
 */

import { getUserModel, upsertUserModel } from "../db/user-model.ts";
import { updateMemoryMetadata } from "../db/memory.ts";
import type { ExtractedKnowledge, ExtractedDecisionPattern, ExtractedValue } from "./extractor.ts";

/** Maximum confidence — never reach 1.0 to allow for change. */
const MAX_CONFIDENCE = 0.95;

/** Minimum confidence before an entry is effectively forgotten. */
const MIN_CONFIDENCE = 0.1;

/**
 * Calculate updated confidence as a weighted running average.
 * Repeated confirmations increase confidence; new entries start at extraction confidence.
 */
function mergeConfidence(existing: number, incoming: number): number {
  // Weighted average: existing has more weight as it accumulates
  const merged = existing * 0.6 + incoming * 0.4;
  // Boost slightly for repeated confirmation
  const boosted = Math.min(merged + 0.05, MAX_CONFIDENCE);
  return Math.round(boosted * 100) / 100;
}

/**
 * Process extracted knowledge into the user model.
 * Upserts preferences, facts, and handles corrections.
 */
export async function updateUserModel(
  extracted: ExtractedKnowledge,
  sourceChunkIds: string[],
): Promise<void> {
  // Process preferences
  for (const pref of extracted.preferences) {
    const existing = await getUserModel("preference");
    const match = existing.find((e) => e.key === pref.key);

    const confidence = match ? mergeConfidence(match.confidence, pref.confidence) : pref.confidence;

    await upsertUserModel({
      category: "preference",
      key: pref.key,
      value: pref.value,
      sourceIds: sourceChunkIds,
      confidence,
    });
  }

  // Process facts
  for (const fact of extracted.facts) {
    // Use first entity as key, or hash of text
    const key =
      fact.entities.length > 0
        ? fact.entities[0].toLowerCase().replace(/\s+/g, "_")
        : fact.text.slice(0, 50).toLowerCase().replace(/\s+/g, "_");

    const existing = await getUserModel("fact");
    const match = existing.find((e) => e.key === key);

    const confidence = match ? mergeConfidence(match.confidence, fact.confidence) : fact.confidence;

    await upsertUserModel({
      category: "fact",
      key,
      value: { text: fact.text, entities: fact.entities },
      sourceIds: sourceChunkIds,
      confidence,
    });
  }

  // Process corrections: mark original as superseded, store corrected value
  for (const corr of extracted.corrections) {
    // Find and mark the original memory chunk as superseded
    const corrChunkId = sourceChunkIds.find((id) => id.startsWith("corr:"));
    if (corrChunkId) {
      // Try to find an original chunk that matches
      // Update its metadata to mark it as superseded
      try {
        const { searchMemoryByText } = await import("../db/memory.ts");
        const originals = await searchMemoryByText(corr.original, 1);
        if (originals.length > 0) {
          await updateMemoryMetadata(originals[0].id, {
            superseded_by: corrChunkId,
          });
        }
      } catch {
        // Best-effort — don't fail on supersession marking
      }
    }

    // Store correction as a fact with the corrected information
    const key = `correction_${corr.corrected.slice(0, 30).toLowerCase().replace(/\s+/g, "_")}`;

    // Decrease confidence of any contradicting entries
    const existing = await getUserModel();
    for (const entry of existing) {
      const valueStr = typeof entry.value === "string" ? entry.value : JSON.stringify(entry.value);
      if (valueStr.toLowerCase().includes(corr.original.toLowerCase())) {
        const decreased = Math.max(entry.confidence - 0.2, MIN_CONFIDENCE);
        await upsertUserModel({
          category: entry.category,
          key: entry.key,
          value: entry.value,
          sourceIds: entry.sourceIds,
          confidence: decreased,
        });
      }
    }

    await upsertUserModel({
      category: "fact",
      key,
      value: { text: corr.corrected, original: corr.original },
      sourceIds: sourceChunkIds,
      confidence: corr.confidence,
    });
  }

  // Process decision patterns
  for (const pattern of extracted.decisionPatterns) {
    await upsertDecisionPattern(pattern, sourceChunkIds);
  }

  // Process values
  for (const val of extracted.values) {
    await upsertValue(val, sourceChunkIds);
  }
}

/**
 * Merge a decision pattern into the user model.
 * If a similar principle already exists, merge evidence and update weight.
 */
async function upsertDecisionPattern(
  pattern: ExtractedDecisionPattern,
  sourceChunkIds: string[],
): Promise<void> {
  const key = pattern.principle
    .slice(0, 80)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");

  const existing = await getUserModel("decision_pattern");
  const match = existing.find((e) => e.key === key);

  if (match) {
    // Merge: accumulate evidence, update weight via running average
    const prev = match.value as {
      principle: string;
      evidence: string[];
      context: string;
      weight: number;
      exceptions: string[];
    };
    const mergedEvidence = [...new Set([...prev.evidence, ...pattern.evidence])].slice(0, 10);
    const mergedExceptions = [...new Set([...prev.exceptions, ...pattern.exceptions])].slice(0, 5);
    const mergedWeight = prev.weight * 0.7 + pattern.weight * 0.3;
    const confidence = mergeConfidence(match.confidence, pattern.confidence);

    await upsertUserModel({
      category: "decision_pattern",
      key,
      value: {
        principle: pattern.principle,
        evidence: mergedEvidence,
        context: pattern.context || prev.context,
        weight: Math.round(mergedWeight * 100) / 100,
        exceptions: mergedExceptions,
      },
      sourceIds: sourceChunkIds,
      confidence,
    });
  } else {
    await upsertUserModel({
      category: "decision_pattern",
      key,
      value: {
        principle: pattern.principle,
        evidence: pattern.evidence,
        context: pattern.context,
        weight: pattern.weight,
        exceptions: pattern.exceptions,
      },
      sourceIds: sourceChunkIds,
      confidence: pattern.confidence,
    });
  }
}

/**
 * Merge a value into the user model.
 * If the same value label exists, accumulate evidence and update description.
 */
async function upsertValue(val: ExtractedValue, sourceChunkIds: string[]): Promise<void> {
  const key = val.value
    .slice(0, 60)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");

  const existing = await getUserModel("value");
  const match = existing.find((e) => e.key === key);

  if (match) {
    const prev = match.value as {
      value: string;
      description: string;
      context: string;
      evidence: string[];
    };
    const mergedEvidence = [...new Set([...prev.evidence, ...val.evidence])].slice(0, 10);
    const confidence = mergeConfidence(match.confidence, val.confidence);

    await upsertUserModel({
      category: "value",
      key,
      value: {
        value: val.value,
        description: val.description || prev.description,
        context: val.context || prev.context,
        evidence: mergedEvidence,
      },
      sourceIds: sourceChunkIds,
      confidence,
    });
  } else {
    await upsertUserModel({
      category: "value",
      key,
      value: {
        value: val.value,
        description: val.description,
        context: val.context,
        evidence: val.evidence,
      },
      sourceIds: sourceChunkIds,
      confidence: val.confidence,
    });
  }
}
