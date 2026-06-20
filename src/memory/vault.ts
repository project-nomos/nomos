/**
 * Per-user vault: the agent's long-term memory store.
 *
 * A markdown knowledge base the agent reads and writes in-loop (the memory-tool
 * pattern, with our own backend) and the user can browse and edit. The SOURCE OF
 * TRUTH for what the clone knows. Backed by its own `vault_notes` table, distinct
 * from `wiki_articles` (the derived/compiled wiki projected out of this vault).
 *
 * Isolation is database-per-user (the JWT-scoped DB connection is the boundary),
 * with a per-row `user_id` filter enforced in the `db/vault.ts` queries as
 * zero-trust defense-in-depth on top of it.
 *
 * Writes REVISE (upsert by `(user_id, path)`), they do not append, so the vault
 * does not accrete duplicates or contradictions.
 */

import {
  deleteVaultNote,
  getVaultNote,
  listVaultNotes,
  searchVaultNotes,
  upsertVaultNote,
  type VaultNoteRow,
} from "../db/vault.ts";
import { createHash } from "node:crypto";
import { chunkText } from "./chunker.ts";
import { generateEmbeddings, isEmbeddingAvailable } from "./embeddings.ts";
import { enrichNoteRetrieval } from "./enrichment.ts";
import { deleteMemoryByIdPrefix, storeMemoryChunk } from "../db/memory.ts";
import { traceMemory, tracedRecall } from "./trace.ts";

const MAX_PATH_LEN = 200;

export interface VaultNote {
  path: string;
  title: string;
  content: string;
  updatedAt: Date;
}

/**
 * Validate + normalize a vault path: no traversal, bounded length, sane charset,
 * `.md` suffix. Throws on anything suspicious (path-traversal defense for the
 * agent-controlled path argument).
 */
export function validateVaultPath(path: string): string {
  const p = path.trim().replace(/^\/+/, "");
  if (!p) throw new Error("vault path is empty");
  if (p.length > MAX_PATH_LEN) throw new Error(`vault path too long (max ${MAX_PATH_LEN})`);
  if (p.includes("..")) throw new Error("vault path traversal ('..') is not allowed");
  if (!/^[A-Za-z0-9._/-]+$/.test(p)) throw new Error("vault path has invalid characters");
  return p.endsWith(".md") ? p : `${p}.md`;
}

/** Extract `[[wikilinks]]` from note content (backlinks). */
export function extractWikiLinks(content: string): string[] {
  const links = new Set<string>();
  for (const m of content.matchAll(/\[\[([^\]]+)\]\]/g)) links.add(m[1].trim());
  return [...links];
}

function toNote(row: VaultNoteRow): VaultNote {
  return { path: row.path, title: row.title, content: row.content, updatedAt: row.updated_at };
}

/** Read one note by path. Null if it does not exist. */
export async function vaultRead(userId: string, path: string): Promise<VaultNote | null> {
  const row = await getVaultNote(userId, validateVaultPath(path));
  return row ? toNote(row) : null;
}

/** List the user's vault notes, optionally filtered to a path prefix. */
export async function vaultList(userId: string, prefix?: string): Promise<VaultNote[]> {
  const notes = (await listVaultNotes(userId)).map(toNote);
  return prefix ? notes.filter((n) => n.path.startsWith(prefix)) : notes;
}

/** Write or revise a note (upsert by user + path). Returns the stored note. */
export async function vaultWrite(
  userId: string,
  path: string,
  content: string,
  opts?: { title?: string },
): Promise<VaultNote> {
  const p = validateVaultPath(path);
  const title = opts?.title ?? (p.replace(/\.md$/, "").split("/").pop() || p);
  const row = await upsertVaultNote(userId, p, title, content, extractWikiLinks(content));
  // Also index into vector memory so the agent's hybrid memory_search surfaces
  // self-written notes, not only the FTS path. Fire-and-forget; never blocks.
  void indexNoteIntoVectorMemory(userId, p, content).catch(() => {});
  traceMemory({ op: "write_vault", userId, ref: p, writeCount: 1 });
  return toNote(row);
}

/**
 * Forget a note ("forget this"). Removes it from the vault AND from the vector
 * store, so a forgotten note does not linger in semantic recall. No-op if it
 * does not exist.
 */
export async function vaultDelete(userId: string, path: string): Promise<void> {
  const p = validateVaultPath(path);
  await deleteVaultNote(userId, p);
  // Forget = full forget: drop this note's vector chunks too. Fire-and-forget;
  // a failure here must not make the user-visible delete fail.
  void deleteMemoryByIdPrefix(userId, vaultChunkIdPrefix(userId, p)).catch(() => {});
  traceMemory({ op: "forget", userId, ref: p });
}

/**
 * Keyword search across the user's vault notes (FTS), scoped to this user.
 * Semantic recall at scale is the separate `memory_search` (vector), which also
 * surfaces vault notes because `vaultWrite` indexes them into the vector store.
 */
export async function vaultSearch(userId: string, query: string, limit = 8): Promise<VaultNote[]> {
  return tracedRecall("recall_vault", userId, query, async () =>
    (await searchVaultNotes(userId, query, limit)).map(toNote),
  );
}

/**
 * Deterministic, user-namespaced id prefix for a note's vector chunks
 * (`vault:<hash(userId:path)>:`). User-namespaced so two users who share a note
 * path get distinct chunk ids, and so a revise or a delete targets exactly one
 * user's chunks for that note.
 */
function vaultChunkIdPrefix(userId: string, path: string): string {
  const docHash = createHash("sha256").update(`${userId}:${path}`).digest("hex").slice(0, 16);
  return `vault:${docHash}:`;
}

/**
 * Index a vault note into the vector memory store (memory_chunks), source
 * "vault", so the agent's hybrid memory_search surfaces self-written notes, not
 * only the FTS path. Deterministic id per (user, path) so a revise overwrites the
 * prior chunks. Embeds when embeddings are available, else text-only (FTS).
 */
async function indexNoteIntoVectorMemory(
  userId: string,
  path: string,
  content: string,
): Promise<void> {
  if (!content.trim()) return;
  const chunks = chunkText(content);
  if (chunks.length === 0) return;

  let embeddings: number[][] | undefined;
  if (isEmbeddingAvailable()) {
    try {
      embeddings = await generateEmbeddings(chunks.map((c) => c.text));
    } catch {
      /* store text-only; FTS still works */
    }
  }
  const model = process.env.EMBEDDING_MODEL ?? "gemini-embedding-001";
  const idPrefix = vaultChunkIdPrefix(userId, path);

  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    await storeMemoryChunk({
      id: `${idPrefix}${i}`,
      userId,
      source: "vault",
      path,
      text: c.text,
      embedding: embeddings?.[i],
      startLine: c.startLine,
      endLine: c.endLine,
      hash: createHash("sha256").update(c.text).digest("hex").slice(0, 16),
      model: embeddings?.[i] ? model : undefined,
    });
  }

  // Write-time retrieval enrichment: store paraphrase aliases so semantically
  // phrased queries land on this note. Best-effort; already off the awaited path
  // (vaultWrite fires indexNoteIntoVectorMemory fire-and-forget). Self-gates on
  // config.memoryEnrichment + embeddings.
  await enrichNoteRetrieval(userId, path, content);
}
