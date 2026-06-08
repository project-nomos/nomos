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
import { createLogger } from "../lib/logger.ts";

const log = createLogger("wiki-sync");

// Resolved at call time (not module load) so NOMOS_WIKI_DIR set later still wins;
// the eval points it at a temp dir to keep disk writes out of the real ~/.nomos.
function wikiBaseDir(): string {
  return process.env.NOMOS_WIKI_DIR ?? path.join(homedir(), ".nomos", "wiki");
}

/**
 * Per-owner disk cache dir. The single-user 'local' install keeps the original
 * ~/.nomos/wiki/ path; other owners get a namespaced subdir so a multi-user DB
 * does not leak every member's articles into one directory.
 */
function wikiDir(userId: string): string {
  return userId === "local" ? wikiBaseDir() : path.join(wikiBaseDir(), userId);
}

/** Sync all wiki articles from DB to disk, for one owner. */
export async function syncToDisk(userId: string): Promise<number> {
  const articles = await listArticles(userId);
  const baseDir = wikiDir(userId);

  fs.mkdirSync(baseDir, { recursive: true });

  let count = 0;
  for (const article of articles) {
    const filePath = path.join(baseDir, article.path);
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, article.content, "utf-8");
    count++;
  }

  log.info({ count }, "Synced articles to disk");
  return count;
}

/** Sync user-edited files from disk to DB (for when user edits wiki in Obsidian/VS Code). */
export async function syncToDb(userId: string): Promise<number> {
  const baseDir = wikiDir(userId);
  if (!fs.existsSync(baseDir)) return 0;

  let count = 0;
  const files = walkDir(baseDir);

  for (const filePath of files) {
    if (!filePath.endsWith(".md")) continue;

    const relativePath = path.relative(baseDir, filePath);
    const content = fs.readFileSync(filePath, "utf-8");
    const title = extractTitle(content, relativePath);
    const category = inferCategory(relativePath);

    await upsertArticle(userId, relativePath, title, content, category);
    count++;
  }

  if (count > 0) {
    log.info({ count }, "Synced files from disk to DB");
  }
  return count;
}

/** Run startup reconciliation -- sync from DB to disk if disk is empty/stale. */
export async function reconcileOnStartup(userId: string): Promise<void> {
  const articles = await listArticles(userId);
  if (articles.length === 0) {
    // No articles in DB -- try loading from disk
    const diskCount = await syncToDb(userId);
    if (diskCount > 0) {
      log.info("Loaded wiki from disk into DB");
    }
    return;
  }

  // DB has articles -- sync to disk
  await syncToDisk(userId);
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
