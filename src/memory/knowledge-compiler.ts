/**
 * Knowledge compiler — Karpathy-style wiki compilation.
 *
 * Reads recent ingested messages from memory_chunks and compiles
 * them into structured markdown wiki articles organized by topic.
 *
 * Runs periodically via cron (default: every 2h) or on demand.
 * Uses Sonnet for quality since wiki articles are the agent's
 * primary knowledge surface.
 */

import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { getDb } from "../db/client.ts";
import { runForkedAgent } from "../sdk/forked-agent.ts";
import { upsertArticle, getArticle, listArticles } from "../db/wiki.ts";
import { syncToDisk } from "./wiki-sync.ts";

const LOCK_FILE = path.join(homedir(), ".nomos", "wiki-compiler.lock");
const MIN_INTERVAL_MS = 2 * 60 * 60 * 1000; // 2 hours
const MAX_ARTICLES_PER_RUN = 20;
const COMPILE_MODEL = "claude-sonnet-4-6";

interface CompilationResult {
  articlesCreated: number;
  articlesUpdated: number;
  errors: string[];
}

/**
 * Run the knowledge compilation pipeline.
 *
 * 1. Gather recent ingested messages since last compilation
 * 2. Group by contact and topic
 * 3. Compile/update wiki articles via LLM
 * 4. Update indexes
 * 5. Sync to disk
 */
export async function compileKnowledge(): Promise<CompilationResult> {
  // Lock file coordination (same pattern as auto-dream)
  if (fs.existsSync(LOCK_FILE)) {
    const lockAge = Date.now() - fs.statSync(LOCK_FILE).mtimeMs;
    if (lockAge < MIN_INTERVAL_MS) {
      return { articlesCreated: 0, articlesUpdated: 0, errors: ["Skipped: too recent"] };
    }
    // Stale lock — remove it
    fs.unlinkSync(LOCK_FILE);
  }

  const lockDir = path.dirname(LOCK_FILE);
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(LOCK_FILE, new Date().toISOString());

  const result: CompilationResult = { articlesCreated: 0, articlesUpdated: 0, errors: [] };

  try {
    const sql = getDb();

    // Get last compilation time
    const existingArticles = await listArticles();
    const lastCompiled = existingArticles.reduce(
      (latest, a) => (a.compiled_at > latest ? a.compiled_at : latest),
      new Date(0),
    );

    // Fetch recent messages since last compilation
    const recentMessages = await sql<
      Array<{
        contact: string;
        contactName: string | null;
        content: string;
        platform: string;
        timestamp: string;
        direction: string;
      }>
    >`
      SELECT
        metadata->>'contact' AS contact,
        metadata->>'contactName' AS "contactName",
        text AS content,
        metadata->>'platform' AS platform,
        metadata->>'timestamp' AS timestamp,
        metadata->>'direction' AS direction
      FROM memory_chunks
      WHERE metadata->>'source' = 'ingest'
        AND created_at > ${lastCompiled}
      ORDER BY created_at ASC
      LIMIT 2000
    `;

    if (recentMessages.length === 0) {
      return result;
    }

    // Group by contact
    type MessageRow = {
      contact: string;
      contactName: string | null;
      content: string;
      platform: string;
      timestamp: string;
      direction: string;
    };
    const byContact = new Map<string, MessageRow[]>();
    for (const msg of recentMessages) {
      const key = msg.contact || "unknown";
      const group = byContact.get(key) ?? [];
      group.push(msg);
      byContact.set(key, group);
    }

    // Compile contact articles
    let articlesProcessed = 0;
    for (const [contact, messages] of byContact) {
      if (articlesProcessed >= MAX_ARTICLES_PER_RUN) break;

      try {
        const contactName = messages.find((m) => m.contactName)?.contactName ?? contact;
        const articlePath = `contacts/${slugify(contactName)}.md`;
        const existing = await getArticle(articlePath);

        const article = await compileContactArticle(
          contactName,
          messages,
          existing?.content ?? null,
        );

        const isNew = !existing;
        await upsertArticle(articlePath, contactName, article, "contacts", [], COMPILE_MODEL);

        if (isNew) result.articlesCreated++;
        else result.articlesUpdated++;
        articlesProcessed++;
      } catch (err) {
        result.errors.push(`${contact}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Update index
    await updateIndex();

    // Sync to disk
    await syncToDisk();

    console.log(
      `[knowledge-compiler] Done: ${result.articlesCreated} created, ${result.articlesUpdated} updated`,
    );
  } finally {
    // Update lock file timestamp
    if (fs.existsSync(LOCK_FILE)) {
      fs.writeFileSync(LOCK_FILE, new Date().toISOString());
    }
  }

  return result;
}

async function compileContactArticle(
  contactName: string,
  messages: Array<{
    content: string;
    platform: string;
    timestamp: string;
    direction: string;
  }>,
  existingContent: string | null,
): Promise<string> {
  const sampleText = messages
    .map((m) => {
      const dir = m.direction === "sent" ? "Me" : contactName;
      return `[${m.timestamp}] ${dir}: ${m.content}`;
    })
    .join("\n")
    .slice(0, 6000);

  const existingSection = existingContent
    ? `\n\nEXISTING ARTICLE (update, don't replace):\n${existingContent.slice(0, 2000)}`
    : "";

  const prompt = `Compile a wiki article about "${contactName}" based on these communication samples.
${existingSection}

RECENT MESSAGES:
${sampleText}

Write a concise markdown article with these sections:
# ${contactName}
## Overview (who they are, relationship)
## Communication Style (how they communicate)
## Key Topics (what you discuss)
## Recent Activity (latest interactions summary)

Keep it factual and useful. Under 500 words. Return ONLY the markdown.`;

  const result = await runForkedAgent({
    prompt,
    model: COMPILE_MODEL,
    label: `wiki-compile:${contactName}`,
    maxTurns: 3,
  });

  return result.text.trim();
}

async function updateIndex(): Promise<void> {
  const articles = await listArticles();
  if (articles.length === 0) return;

  const indexLines = ["# Knowledge Wiki Index\n"];
  const categories = new Map<string, typeof articles>();

  for (const article of articles) {
    const group = categories.get(article.category) ?? [];
    group.push(article);
    categories.set(article.category, group);
  }

  for (const [category, items] of categories) {
    indexLines.push(`## ${category}`);
    for (const item of items) {
      indexLines.push(`- [${item.title}](${item.path})`);
    }
    indexLines.push("");
  }

  await upsertArticle("_index.md", "Knowledge Wiki Index", indexLines.join("\n"), "index");
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
