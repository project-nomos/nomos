/**
 * Wiki reader — retrieves relevant wiki articles for agent context.
 *
 * Agent reads wiki articles first (cheap, structured), then falls
 * back to vector search for details not in the wiki.
 */

import { getArticle, searchArticles, listArticles, type WikiArticleRow } from "../db/wiki.ts";

const MAX_CONTEXT_ARTICLES = 5;
const MAX_CONTEXT_CHARS = 4000;

/**
 * Get relevant wiki articles for a given query/context.
 *
 * Strategy:
 * 1. Check _index.md for overview
 * 2. Full-text search wiki articles matching the query
 * 3. Return top matches within context budget
 */
export async function getRelevantArticles(query: string): Promise<string> {
  if (!query) return "";

  // Search wiki articles
  const matches = await searchArticles(query, MAX_CONTEXT_ARTICLES);
  if (matches.length === 0) return "";

  return formatArticlesForContext(matches);
}

/**
 * Get a specific wiki article by path.
 */
export async function getArticleContent(path: string): Promise<string | null> {
  const article = await getArticle(path);
  return article?.content ?? null;
}

/**
 * Get all contact-related wiki articles.
 */
export async function getContactArticles(): Promise<WikiArticleRow[]> {
  return listArticles("contacts");
}

/** Format wiki articles into context text for the agent. */
function formatArticlesForContext(articles: WikiArticleRow[]): string {
  const lines: string[] = ["## Personal Knowledge Wiki\n"];
  let totalChars = 0;

  for (const article of articles) {
    if (totalChars + article.content.length > MAX_CONTEXT_CHARS) {
      // Truncate the article
      const remaining = MAX_CONTEXT_CHARS - totalChars;
      if (remaining > 200) {
        lines.push(`### ${article.title}`);
        lines.push(article.content.slice(0, remaining) + "...\n");
      }
      break;
    }

    lines.push(`### ${article.title}`);
    lines.push(article.content + "\n");
    totalChars += article.content.length;
  }

  return lines.join("\n");
}
