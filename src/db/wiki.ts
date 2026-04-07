/**
 * CRUD operations for the wiki_articles table.
 *
 * The wiki is DB-primary — articles are stored in the database and
 * synced to ~/.nomos/wiki/ as a readable cache.
 */

import { getDb } from "./client.ts";

export interface WikiArticleRow {
  id: string;
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
  path: string,
  title: string,
  content: string,
  category: string,
  backlinks: string[] = [],
  compileModel?: string,
): Promise<WikiArticleRow> {
  const sql = getDb();
  const wordCount = content.split(/\s+/).length;

  const [row] = await sql<WikiArticleRow[]>`
    INSERT INTO wiki_articles (path, title, content, category, backlinks, word_count, compile_model, compiled_at)
    VALUES (${path}, ${title}, ${content}, ${category}, ${backlinks}, ${wordCount}, ${compileModel ?? null}, now())
    ON CONFLICT (path)
    DO UPDATE SET
      title = EXCLUDED.title,
      content = EXCLUDED.content,
      category = EXCLUDED.category,
      backlinks = EXCLUDED.backlinks,
      word_count = EXCLUDED.word_count,
      compile_model = EXCLUDED.compile_model,
      compiled_at = now(),
      updated_at = now()
    RETURNING *
  `;
  return row;
}

export async function getArticle(path: string): Promise<WikiArticleRow | null> {
  const sql = getDb();
  const rows = await sql<WikiArticleRow[]>`
    SELECT * FROM wiki_articles WHERE path = ${path}
  `;
  return rows[0] ?? null;
}

export async function listArticles(category?: string): Promise<WikiArticleRow[]> {
  const sql = getDb();
  if (category) {
    return sql<WikiArticleRow[]>`
      SELECT * FROM wiki_articles WHERE category = ${category} ORDER BY path
    `;
  }
  return sql<WikiArticleRow[]>`SELECT * FROM wiki_articles ORDER BY path`;
}

export async function searchArticles(query: string, limit: number = 10): Promise<WikiArticleRow[]> {
  const sql = getDb();
  return sql<WikiArticleRow[]>`
    SELECT *, ts_rank(to_tsvector('english', content), plainto_tsquery('english', ${query})) AS rank
    FROM wiki_articles
    WHERE to_tsvector('english', content) @@ plainto_tsquery('english', ${query})
    ORDER BY rank DESC
    LIMIT ${limit}
  `;
}

export async function deleteArticle(path: string): Promise<void> {
  const sql = getDb();
  await sql`DELETE FROM wiki_articles WHERE path = ${path}`;
}

export async function getArticlesByCategory(): Promise<Array<{ category: string; count: number }>> {
  const sql = getDb();
  return sql<{ category: string; count: number }[]>`
    SELECT category, COUNT(*)::int AS count
    FROM wiki_articles
    GROUP BY category
    ORDER BY count DESC
  `;
}
