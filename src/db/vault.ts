/**
 * CRUD for the `vault_notes` table: the agent's per-user long-term memory and
 * the source of truth for what the clone knows.
 *
 * Distinct from `wiki_articles` (the derived/compiled wiki). Every query is
 * scoped by `user_id` as zero-trust defense-in-depth on top of database-per-user,
 * so a note written by one user can never be read or revised by another even if
 * they shared a connection. Writes REVISE (upsert by `(user_id, path)`), they do
 * not append.
 */

import { sql } from "kysely";
import { getKysely } from "./client.ts";
import { ftsMatch, ftsRank } from "./sql-helpers.ts";

export interface VaultNoteRow {
  id: string;
  user_id: string;
  path: string;
  title: string;
  content: string;
  backlinks: string[];
  word_count: number;
  created_at: Date;
  updated_at: Date;
}

export async function upsertVaultNote(
  userId: string,
  path: string,
  title: string,
  content: string,
  backlinks: string[] = [],
): Promise<VaultNoteRow> {
  const db = getKysely();
  const wordCount = content.split(/\s+/).filter(Boolean).length;

  const row = await db
    .insertInto("vault_notes")
    .values({
      user_id: userId,
      path,
      title,
      content,
      backlinks,
      word_count: wordCount,
    })
    .onConflict((oc) =>
      oc.columns(["user_id", "path"]).doUpdateSet({
        title: sql`EXCLUDED.title`,
        content: sql`EXCLUDED.content`,
        backlinks: sql`EXCLUDED.backlinks`,
        word_count: sql`EXCLUDED.word_count`,
        updated_at: sql`now()`,
      }),
    )
    .returningAll()
    .executeTakeFirstOrThrow();
  return row as unknown as VaultNoteRow;
}

export async function getVaultNote(userId: string, path: string): Promise<VaultNoteRow | null> {
  const db = getKysely();
  const row = await db
    .selectFrom("vault_notes")
    .selectAll()
    .where("user_id", "=", userId)
    .where("path", "=", path)
    .executeTakeFirst();
  return (row as unknown as VaultNoteRow) ?? null;
}

export async function listVaultNotes(userId: string): Promise<VaultNoteRow[]> {
  const db = getKysely();
  return db
    .selectFrom("vault_notes")
    .selectAll()
    .where("user_id", "=", userId)
    .orderBy("path")
    .execute() as unknown as Promise<VaultNoteRow[]>;
}

export async function searchVaultNotes(
  userId: string,
  query: string,
  limit: number = 10,
): Promise<VaultNoteRow[]> {
  const db = getKysely();
  const rows = await db
    .selectFrom("vault_notes")
    .selectAll()
    .select(ftsRank("content", query).as("rank"))
    .where("user_id", "=", userId)
    .where(ftsMatch("content", query))
    .orderBy("rank", "desc")
    .limit(limit)
    .execute();
  return rows as unknown as VaultNoteRow[];
}

export async function deleteVaultNote(userId: string, path: string): Promise<void> {
  const db = getKysely();
  await db
    .deleteFrom("vault_notes")
    .where("user_id", "=", userId)
    .where("path", "=", path)
    .execute();
}
