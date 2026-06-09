/**
 * CRUD operations for the wiki_articles table.
 *
 * The wiki is DB-primary -- articles are stored in the database and
 * synced to ~/.nomos/wiki/ as a readable cache.
 *
 * Scoped by `userId` (the owner): the compiled wiki is per-person, derived from
 * that person's vault + signals, so every read/write filters by user_id.
 */

import { sql } from "kysely";
import { getKysely } from "./client.ts";
import { ftsMatch, ftsRank } from "./sql-helpers.ts";

export interface WikiArticleRow {
  id: string;
  user_id: string;
  path: string;
  title: string;
  content: string;
  category: string;
  backlinks: string[];
  word_count: number;
  compile_model: string | null;
  compiled_at: Date;
  created_at: Date;
  updated_at: Date;
}

export async function upsertArticle(
  userId: string,
  path: string,
  title: string,
  content: string,
  category: string,
  backlinks: string[] = [],
  compileModel?: string,
): Promise<WikiArticleRow> {
  const db = getKysely();
  const wordCount = content.split(/\s+/).length;
  // 'memory' is reserved: it is the legacy category the vault used before it got
  // its own table, and the migration unconditionally DELETEs wiki_articles rows
  // with that category on every migrate. Remap so a compiled article or a
  // user-created `memory/` wiki folder can never be silently retired.
  const safeCategory = category === "memory" ? "general" : category;

  const row = await db
    .insertInto("wiki_articles")
    .values({
      user_id: userId,
      path,
      title,
      content,
      category: safeCategory,
      backlinks,
      word_count: wordCount,
      compile_model: compileModel ?? null,
      compiled_at: sql`now()`,
    })
    .onConflict((oc) =>
      oc.columns(["user_id", "path"]).doUpdateSet({
        title: sql`EXCLUDED.title`,
        content: sql`EXCLUDED.content`,
        category: sql`EXCLUDED.category`,
        backlinks: sql`EXCLUDED.backlinks`,
        word_count: sql`EXCLUDED.word_count`,
        compile_model: sql`EXCLUDED.compile_model`,
        compiled_at: sql`now()`,
        updated_at: sql`now()`,
      }),
    )
    .returningAll()
    .executeTakeFirstOrThrow();
  return row as unknown as WikiArticleRow;
}

export async function getArticle(userId: string, path: string): Promise<WikiArticleRow | null> {
  const db = getKysely();
  const row = await db
    .selectFrom("wiki_articles")
    .selectAll()
    .where("user_id", "=", userId)
    .where("path", "=", path)
    .executeTakeFirst();
  return (row as unknown as WikiArticleRow) ?? null;
}

export async function listArticles(userId: string, category?: string): Promise<WikiArticleRow[]> {
  const db = getKysely();
  let query = db
    .selectFrom("wiki_articles")
    .selectAll()
    .where("user_id", "=", userId)
    .orderBy("path");

  if (category) {
    query = query.where("category", "=", category);
  }

  return query.execute() as unknown as Promise<WikiArticleRow[]>;
}

export async function searchArticles(
  userId: string,
  query: string,
  limit: number = 10,
): Promise<WikiArticleRow[]> {
  const db = getKysely();
  const rows = await db
    .selectFrom("wiki_articles")
    .selectAll()
    .select(ftsRank("content", query).as("rank"))
    .where("user_id", "=", userId)
    .where(ftsMatch("content", query))
    .orderBy("rank", "desc")
    .limit(limit)
    .execute();
  return rows as unknown as WikiArticleRow[];
}

export async function deleteArticle(userId: string, path: string): Promise<void> {
  const db = getKysely();
  await db
    .deleteFrom("wiki_articles")
    .where("user_id", "=", userId)
    .where("path", "=", path)
    .execute();
}

export async function getArticlesByCategory(
  userId: string,
): Promise<Array<{ category: string; count: number }>> {
  const db = getKysely();
  return db
    .selectFrom("wiki_articles")
    .select(["category", sql<number>`COUNT(*)::int`.as("count")])
    .where("user_id", "=", userId)
    .groupBy("category")
    .orderBy("count", "desc")
    .execute();
}
