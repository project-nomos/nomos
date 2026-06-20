/**
 * Write-time retrieval enrichment.
 *
 * Paraphrase recall ("which carrier do I book" against a note that says "flies
 * United") is the hard tail of memory search: FTS can't bridge it and the vector
 * arm sometimes ranks the right note just below the top-k. The fix is to enrich
 * the WRITE side, not the read side. When a note is indexed (already an async,
 * off-hot-path step), a bounded Haiku fork generates the alternate phrasings /
 * questions the note answers, and each is embedded as an extra memory_chunk that
 * points at the SAME note path. A paraphrase query then has a direct vector
 * neighbor and lands on the note.
 *
 * The LLM cost is paid once per write, in the background, so READ latency is
 * unchanged (the whole point: no per-query expansion tax). Alias chunk ids are
 * deterministic per (note, i) so re-enriching a revised note upserts in place and
 * never duplicates; a forget removes them via the shared `vault:<hash>:` prefix.
 */

import { createHash } from "node:crypto";
import { loadEnvConfig } from "../config/env.ts";
import { storeMemoryChunk } from "../db/memory.ts";
import { createLogger } from "../lib/logger.ts";
import { runForkedAgent } from "../sdk/forked-agent.ts";
import { generateEmbeddings, isEmbeddingAvailable } from "./embeddings.ts";

const log = createLogger("enrichment");

const MAX_ALIASES = 5;
const MIN_CONTENT_LEN = 40; // not worth a fork for a tiny note
const ALIAS_MODEL = "claude-haiku-4-5";

const ALIAS_PROMPT = `You expand a stored memory into the SEARCH QUERIES a user would later type to find it. Given the note below, list the distinct natural-language questions or search phrases this note answers -- especially ones that use DIFFERENT words than the note (synonyms, the category, the underlying intent), since exact-word queries already match.

Rules:
- Output ONLY a JSON array of strings, at most ${MAX_ALIASES}, no prose.
- Each phrase is something a user would actually type ("which carrier do I fly", not "the user's airline preference").
- Vary the vocabulary; do not just echo the note's wording.
- If the note holds no durable, recallable fact, output [].

Note:
"""
{content}
"""`;

/** Deterministic doc hash for a note, matching vault chunk id namespacing. */
function noteHash(userId: string, path: string): string {
  return createHash("sha256").update(`${userId}:${path}`).digest("hex").slice(0, 16);
}

/** Deterministic id for alias chunk `i` of a note (`vault:<hash>:alias:<i>`). */
export function aliasChunkId(userId: string, path: string, i: number): string {
  return `vault:${noteHash(userId, path)}:alias:${i}`;
}

/**
 * Parse the forked model's output into a clean, bounded, de-duplicated alias
 * list. Never throws -- enrichment is best-effort.
 */
export function parseAliases(raw: string): string[] {
  // Models often fence the JSON in ```json ... ``` and sometimes repeat the whole
  // array; strip fences and take the FIRST array (non-greedy) so a duplicated or
  // fenced answer still parses.
  const cleaned = raw.replace(/```(?:json)?/gi, " ");
  const match = cleaned.match(/\[[\s\S]*?\]/);
  if (!match) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(match[0]);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];

  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of arr) {
    if (typeof item !== "string") continue;
    const s = item.trim();
    if (s.length < 3 || s.length > 200) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= MAX_ALIASES) break;
  }
  return out;
}

/**
 * Generate alias phrasings for a piece of content via a bounded Haiku fork.
 * Returns [] on any failure (never throws); enrichment is best-effort.
 */
export async function generateRetrievalAliases(content: string): Promise<string[]> {
  if (content.trim().length < MIN_CONTENT_LEN) return [];
  try {
    const { text } = await runForkedAgent({
      prompt: ALIAS_PROMPT.replace("{content}", content.slice(0, 2000)),
      model: ALIAS_MODEL,
      systemPromptAppend: "You output only a JSON array of strings. No explanations.",
      maxTurns: 1,
      label: "retrieval-enrichment",
      allowedTools: [],
    });
    return parseAliases(text);
  } catch (err) {
    log.debug({ err }, "alias generation failed");
    return [];
  }
}

/**
 * Enrich a note's retrieval surface: generate alias phrasings and store each as
 * its own embedded memory_chunk pointing at the SAME note path, so paraphrase
 * queries land on the note. Best-effort; never throws. Returns the count written.
 *
 * Gated on `config.memoryEnrichment` (unless `force`) AND embeddings being
 * available -- without a vector there is no paraphrase win, only FTS the note
 * already serves. Idempotent on (userId, path) via deterministic alias ids.
 */
export async function enrichNoteRetrieval(
  userId: string,
  path: string,
  content: string,
  opts?: { force?: boolean },
): Promise<number> {
  if ((!opts?.force && !loadEnvConfig().memoryEnrichment) || !isEmbeddingAvailable()) return 0;

  const aliases = await generateRetrievalAliases(content);
  if (aliases.length === 0) return 0;

  let embeddings: number[][];
  try {
    embeddings = await generateEmbeddings(aliases);
  } catch (err) {
    log.debug({ err }, "alias embedding failed");
    return 0;
  }
  const model = process.env.EMBEDDING_MODEL ?? "gemini-embedding-001";

  let written = 0;
  for (let i = 0; i < aliases.length; i++) {
    if (!embeddings[i]) continue;
    try {
      await storeMemoryChunk({
        id: aliasChunkId(userId, path, i),
        userId,
        source: "vault",
        path,
        text: aliases[i],
        embedding: embeddings[i],
        hash: createHash("sha256").update(aliases[i]).digest("hex").slice(0, 16),
        model,
        metadata: { kind: "alias", note: path },
      });
      written++;
    } catch (err) {
      log.debug({ err, path, i }, "alias chunk store failed");
    }
  }
  if (written > 0) log.info({ userId, path, written }, "enriched note retrieval");
  return written;
}
