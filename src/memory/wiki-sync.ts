/**
 * Wiki disk sync.
 *
 * Keeps ~/.nomos/wiki/ in sync with the wiki_articles DB table.
 * DB is the source of truth; disk is a readable cache.
 */

import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { listArticles, upsertArticle } from "../db/wiki.ts";

const WIKI_DIR = path.join(homedir(), ".nomos", "wiki");

/** Sync all wiki articles from DB to disk. */
export async function syncToDisk(): Promise<number> {
  const articles = await listArticles();

  fs.mkdirSync(WIKI_DIR, { recursive: true });

  let count = 0;
  for (const article of articles) {
    const filePath = path.join(WIKI_DIR, article.path);
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, article.content, "utf-8");
    count++;
  }

  console.log(`[wiki-sync] Synced ${count} articles to disk`);
  return count;
}

/** Sync user-edited files from disk to DB (for when user edits wiki in Obsidian/VS Code). */
export async function syncToDb(): Promise<number> {
  if (!fs.existsSync(WIKI_DIR)) return 0;

  let count = 0;
  const files = walkDir(WIKI_DIR);

  for (const filePath of files) {
    if (!filePath.endsWith(".md")) continue;

    const relativePath = path.relative(WIKI_DIR, filePath);
    const content = fs.readFileSync(filePath, "utf-8");
    const title = extractTitle(content, relativePath);
    const category = inferCategory(relativePath);

    await upsertArticle(relativePath, title, content, category);
    count++;
  }

  if (count > 0) {
    console.log(`[wiki-sync] Synced ${count} files from disk to DB`);
  }
  return count;
}

/** Run startup reconciliation — sync from DB to disk if disk is empty/stale. */
export async function reconcileOnStartup(): Promise<void> {
  const articles = await listArticles();
  if (articles.length === 0) {
    // No articles in DB — try loading from disk
    const diskCount = await syncToDb();
    if (diskCount > 0) {
      console.log("[wiki-sync] Loaded wiki from disk into DB");
    }
    return;
  }

  // DB has articles — sync to disk
  await syncToDisk();
}

function walkDir(dir: string): string[] {
  const files: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkDir(full));
    } else {
      files.push(full);
    }
  }
  return files;
}

function extractTitle(content: string, fallback: string): string {
  const match = content.match(/^#\s+(.+)/m);
  if (match) return match[1].trim();
  return path.basename(fallback, ".md").replace(/-/g, " ");
}

function inferCategory(relativePath: string): string {
  const parts = relativePath.split(path.sep);
  if (parts.length > 1) return parts[0]; // First directory = category
  if (relativePath.startsWith("_")) return "index";
  return "general";
}
