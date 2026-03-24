import {
  searchMemoryByVector,
  searchMemoryByText,
  recordMemoryAccess,
  type MemorySearchResult,
} from "../db/memory.ts";

const RRF_K = 60;

/** Decay rate for the Ebbinghaus forgetting curve (per day). */
const DECAY_RATE = 0.05;

/** Access reinforcement factor — each access slightly boosts relevance. */
const ACCESS_BOOST = 0.02;

// Common English stop words to filter out during keyword extraction
const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "has",
  "he",
  "in",
  "is",
  "it",
  "its",
  "of",
  "on",
  "that",
  "the",
  "to",
  "was",
  "will",
  "with",
  "this",
  "about",
  "what",
  "when",
  "where",
  "who",
  "how",
  "thing",
]);

/**
 * Calculate temporal decay multiplier using the Ebbinghaus forgetting curve.
 * Formula: e^(-DECAY_RATE * days) * (1 + ACCESS_BOOST * access_count)
 *
 * Recent, frequently accessed memories score higher.
 * Very old, never-accessed memories decay toward 0.
 */
function temporalDecay(createdAt: Date | undefined, accessCount: number | undefined): number {
  if (!createdAt) return 1; // No date info — no penalty
  const now = Date.now();
  const ageMs = now - new Date(createdAt).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  const decay = Math.exp(-DECAY_RATE * ageDays);
  const reinforcement = 1 + ACCESS_BOOST * (accessCount ?? 0);
  return decay * reinforcement;
}

/**
 * Apply temporal decay to a list of scored results and re-sort.
 */
function applyTemporalDecay(results: MemorySearchResult[]): MemorySearchResult[] {
  return results
    .map((result) => ({
      ...result,
      score: result.score * temporalDecay(result.created_at, result.access_count),
    }))
    .sort((a, b) => b.score - a.score);
}

/**
 * Record access for returned search results (fire-and-forget).
 */
function trackAccess(results: MemorySearchResult[]): void {
  const ids = results.map((r) => r.id);
  recordMemoryAccess(ids).catch(() => {
    // best-effort — don't fail searches over access tracking
  });
}

/**
 * Extract meaningful keywords from a conversational query.
 * Removes stop words and keeps words longer than 2 characters.
 */
function extractKeywords(query: string): string {
  const words = query.toLowerCase().match(/\b\w+\b/g) || [];
  const keywords = words.filter((word) => word.length > 2 && !STOP_WORDS.has(word));
  return keywords.join(" ") || query;
}

/**
 * Text-only search fallback when embeddings are unavailable.
 * Uses keyword extraction and returns results with normalized scores.
 * Applies temporal decay to boost recent/frequently accessed memories.
 */
export async function textOnlySearch(
  query: string,
  limit: number = 10,
  category?: string,
): Promise<MemorySearchResult[]> {
  const keywords = extractKeywords(query);
  const results = await searchMemoryByText(keywords, limit * 2, category);

  // Normalize scores to 0-1 range based on rank, then apply temporal decay
  const scored = results.map((result, rank) => ({
    ...result,
    score: 1 / (RRF_K + rank + 1),
  }));

  const decayed = applyTemporalDecay(scored).slice(0, limit);
  trackAccess(decayed);
  return decayed;
}

/**
 * Hybrid search combining vector similarity and full-text search.
 * Uses Reciprocal Rank Fusion (RRF) to merge results.
 * Applies temporal decay to boost recent/frequently accessed memories.
 */
export async function hybridSearch(
  query: string,
  embedding: number[],
  limit: number = 10,
  category?: string,
): Promise<MemorySearchResult[]> {
  // Run both searches in parallel
  const [vectorResults, textResults] = await Promise.all([
    searchMemoryByVector(embedding, limit * 2, category),
    searchMemoryByText(query, limit * 2, category),
  ]);

  // Build RRF scores
  const scoreMap = new Map<string, { score: number; result: MemorySearchResult }>();

  // Score vector results by rank
  for (let rank = 0; rank < vectorResults.length; rank++) {
    const result = vectorResults[rank];
    const rrfScore = 1 / (RRF_K + rank + 1);
    const existing = scoreMap.get(result.id);
    if (existing) {
      existing.score += rrfScore;
    } else {
      scoreMap.set(result.id, { score: rrfScore, result });
    }
  }

  // Score text results by rank
  for (let rank = 0; rank < textResults.length; rank++) {
    const result = textResults[rank];
    const rrfScore = 1 / (RRF_K + rank + 1);
    const existing = scoreMap.get(result.id);
    if (existing) {
      existing.score += rrfScore;
    } else {
      scoreMap.set(result.id, { score: rrfScore, result });
    }
  }

  // Apply temporal decay to combined scores and return top results
  const merged = Array.from(scoreMap.values()).map(({ score, result }) => ({
    ...result,
    score,
  }));

  const decayed = applyTemporalDecay(merged).slice(0, limit);
  trackAccess(decayed);
  return decayed;
}
