/**
 * Per-user vault: the agent's long-term memory store.
 *
 * A markdown knowledge base the agent reads and writes in-loop (the memory-tool
 * pattern, with our own backend) and the user can browse and edit. Backed by the
 * `wiki_articles` table; agent-authored notes live under the `memory` category,
 * distinct from the compiled knowledge wiki (contacts, etc.).
 *
 * Isolation is database-per-user (the JWT-scoped DB connection is the boundary).
 * `userId` is threaded through every call so the per-row zero-trust filter can be
 * switched on once `wiki_articles` gains a `user_id` column (v2 hardening); for
 * now it is unused at the query layer.
 *
 * Writes REVISE (upsert by path), they do not append, so the vault does not
 * accrete duplicates or contradictions.
 */

import {
  deleteArticle,
  getArticle,
  listArticles,
  searchArticles,
  upsertArticle,
  type WikiArticleRow,
} from "../db/wiki.ts";

/** Agent-authored notes use this category in wiki_articles. */
export const VAULT_CATEGORY = "memory";
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

function toNote(row: WikiArticleRow): VaultNote {
  return { path: row.path, title: row.title, content: row.content, updatedAt: row.updated_at };
}

/** Read one note by path. Null if it does not exist. */
export async function vaultRead(_userId: string, path: string): Promise<VaultNote | null> {
  const row = await getArticle(validateVaultPath(path));
  return row ? toNote(row) : null;
}

/** List agent memory notes, optionally filtered to a path prefix. */
export async function vaultList(_userId: string, prefix?: string): Promise<VaultNote[]> {
  const notes = (await listArticles(VAULT_CATEGORY)).map(toNote);
  return prefix ? notes.filter((n) => n.path.startsWith(prefix)) : notes;
}

/** Write or revise a note (upsert by path). Returns the stored note. */
export async function vaultWrite(
  _userId: string,
  path: string,
  content: string,
  opts?: { title?: string },
): Promise<VaultNote> {
  const p = validateVaultPath(path);
  const title = opts?.title ?? (p.replace(/\.md$/, "").split("/").pop() || p);
  const row = await upsertArticle(
    p,
    title,
    content,
    VAULT_CATEGORY,
    extractWikiLinks(content),
    "agent",
  );
  return toNote(row);
}

/** Forget a note ("forget this"). No-op if it does not exist. */
export async function vaultDelete(_userId: string, path: string): Promise<void> {
  await deleteArticle(validateVaultPath(path));
}

/**
 * Keyword search across the user's knowledge base (vault notes + compiled wiki).
 * FTS-backed; semantic recall at scale is the separate `memory_search` (vector).
 */
export async function vaultSearch(_userId: string, query: string, limit = 8): Promise<VaultNote[]> {
  return (await searchArticles(query, limit)).map(toNote);
}
