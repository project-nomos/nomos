/**
 * Knowledge compiler -- Karpathy-style wiki compilation.
 *
 * Compiles the agent's accumulated knowledge (user model, conversation
 * memory, contacts) into structured markdown wiki articles. The LLM
 * decides what topics deserve articles based on the available data.
 *
 * Sources:
 *   - user_model: facts, preferences, decision patterns, values
 *   - memory_chunks: conversation history (source = "conversation")
 *   - contacts + contact_identities: identity graph
 *
 * Articles are stored in wiki_articles table and synced to ~/.nomos/wiki/.
 * The managed_files table provides DB backup for disk recovery.
 *
 * Runs: on demand via CLI (`nomos wiki compile`), or periodically via cron.
 */

import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { getDb } from "../db/client.ts";
import { runForkedAgent } from "../sdk/forked-agent.ts";
import { upsertArticle, getArticle, listArticles } from "../db/wiki.ts";
import { syncToDisk } from "./wiki-sync.ts";
import { syncFileToDb } from "../config/file-sync.ts";

const LOCK_FILE = path.join(homedir(), ".nomos", "wiki-compiler.lock");
const WIKI_DIR = path.join(homedir(), ".nomos", "wiki");
const MIN_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
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
 * 1. Gather knowledge from user model + conversations + contacts
 * 2. Ask the LLM what topics deserve articles
 * 3. Compile/update articles
 * 4. Sync to disk + DB backup
 */
export async function compileKnowledge(options?: { force?: boolean }): Promise<CompilationResult> {
  // Lock file coordination
  if (!options?.force && fs.existsSync(LOCK_FILE)) {
    const lockAge = Date.now() - fs.statSync(LOCK_FILE).mtimeMs;
    if (lockAge < MIN_INTERVAL_MS) {
      return { articlesCreated: 0, articlesUpdated: 0, errors: ["Skipped: too recent"] };
    }
    fs.unlinkSync(LOCK_FILE);
  }

  const lockDir = path.dirname(LOCK_FILE);
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(LOCK_FILE, new Date().toISOString());

  const result: CompilationResult = { articlesCreated: 0, articlesUpdated: 0, errors: [] };

  try {
    const sql = getDb();

    // 1. Gather all knowledge sources
    const userModelEntries = await sql`
      SELECT category, key, value::text as value, confidence
      FROM user_model
      WHERE confidence >= 0.6
      ORDER BY confidence DESC
      LIMIT 200
    `;

    const recentConversations = await sql`
      SELECT text, path, created_at
      FROM memory_chunks
      WHERE source = ${"conversation"}
      ORDER BY created_at DESC
      LIMIT 100
    `;

    const contacts = await sql`
      SELECT c.id, c.display_name as name, c.autonomy,
             json_agg(json_build_object(
               'platform', ci.platform,
               'user_id', ci.platform_user_id,
               'display_name', ci.display_name,
               'email', ci.email
             )) as identities
      FROM contacts c
      LEFT JOIN contact_identities ci ON ci.contact_id = c.id
      GROUP BY c.id, c.display_name, c.autonomy
    `;

    const existingArticles = await listArticles();

    // 2. Ask the LLM what articles to create/update
    type ModelEntry = { category: string; key: string; value: string; confidence: number };
    type ContactRow = { id: string; name: string; identities: unknown[] };
    const entries = userModelEntries as unknown as ModelEntry[];
    const contactRows = contacts as unknown as ContactRow[];

    const knowledgeSummary = buildKnowledgeSummary(
      entries,
      contactRows,
      existingArticles.map((a) => a.path),
    );

    const planResult = await runForkedAgent({
      prompt: `You are a knowledge wiki curator. Based on the user's accumulated knowledge, decide which wiki articles to create or update.

${knowledgeSummary}

EXISTING ARTICLES: ${existingArticles.map((a) => a.path).join(", ") || "none"}

Decide which articles are worth creating. Prioritize:
1. People the user interacts with regularly (contacts with details)
2. Projects or topics with substantial accumulated knowledge
3. Key relationships and organizational context

Skip:
- Generic/obvious facts ("user is testing", "system is working")
- Temporary state ("on branch X", "file Y modified")
- Single-fact entries that don't warrant a full article

Return ONLY a JSON array of article plans:
[{"path": "contacts/suren.md", "title": "Suren", "category": "contacts", "description": "compile contact card"}, ...]

Maximum ${MAX_ARTICLES_PER_RUN} articles. Return [] if nothing is worth compiling.`,
      model: COMPILE_MODEL,
      label: "wiki-plan",
      maxTurns: 1,
    });

    let plans: Array<{ path: string; title: string; category: string; description: string }>;
    try {
      const jsonMatch = planResult.text.match(/\[[\s\S]*\]/);
      plans = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
    } catch {
      result.errors.push("Failed to parse article plan");
      return result;
    }

    if (plans.length === 0) {
      console.log("[knowledge-compiler] No articles to compile");
      return result;
    }

    console.log(`[knowledge-compiler] Planning ${plans.length} article(s)`);

    // 3. Compile each article
    for (const plan of plans) {
      try {
        const existing = await getArticle(plan.path);

        // Gather relevant data for this article
        const relevantFacts = entries.filter((e) => {
          const val = String(e.value).toLowerCase();
          const titleLower = plan.title.toLowerCase();
          return val.includes(titleLower) || String(e.key).toLowerCase().includes(titleLower);
        });

        const relevantConvos = (
          recentConversations as unknown as Array<{ text: string; path: string }>
        )
          .filter((c) => c.text.toLowerCase().includes(plan.title.toLowerCase()))
          .slice(0, 10);

        const relevantContact = contactRows.find(
          (c) => c.name.toLowerCase() === plan.title.toLowerCase(),
        );

        const article = await compileArticle(
          plan,
          relevantFacts,
          relevantConvos,
          relevantContact,
          existing?.content ?? null,
        );

        const isNew = !existing;
        await upsertArticle(plan.path, plan.title, article, plan.category, [], COMPILE_MODEL);

        if (isNew) result.articlesCreated++;
        else result.articlesUpdated++;
      } catch (err) {
        result.errors.push(`${plan.path}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // 4. Update index
    await updateIndex();

    // 5. Sync to disk
    await syncToDisk();

    // 6. Backup wiki articles to managed_files table
    await backupWikiToDb();

    console.log(
      `[knowledge-compiler] Done: ${result.articlesCreated} created, ${result.articlesUpdated} updated`,
    );
  } finally {
    if (fs.existsSync(LOCK_FILE)) {
      fs.writeFileSync(LOCK_FILE, new Date().toISOString());
    }
  }

  return result;
}

async function compileArticle(
  plan: { path: string; title: string; category: string },
  facts: Array<{ category: string; key: string; value: string; confidence: number }>,
  conversations: Array<{ text: string; path: string }>,
  contact: { name: string; identities: unknown[] } | undefined,
  existingContent: string | null,
): Promise<string> {
  const factsText = facts
    .map((f) => `[${f.category}] ${f.key}: ${f.value} (confidence: ${f.confidence})`)
    .join("\n");

  const convoText = conversations
    .map((c) => c.text.slice(0, 300))
    .join("\n---\n")
    .slice(0, 4000);

  const contactText = contact
    ? `Contact identities: ${JSON.stringify(contact.identities, null, 2)}`
    : "";

  const existingSection = existingContent
    ? `\nEXISTING ARTICLE (update and merge, don't discard existing info):\n${existingContent.slice(0, 2000)}`
    : "";

  const prompt = `Compile a wiki article about "${plan.title}" (category: ${plan.category}).
${existingSection}

ACCUMULATED FACTS:
${factsText || "No specific facts found"}

CONTACT INFO:
${contactText || "No contact record"}

RELEVANT CONVERSATIONS:
${convoText || "No recent conversations"}

Write a concise, factual markdown article. Include ALL concrete details found (phone numbers, emails, relationships, roles, preferences). Structure with clear headings. Under 500 words.

Return ONLY the markdown article content.`;

  const compiled = await runForkedAgent({
    prompt,
    model: COMPILE_MODEL,
    label: `wiki-compile:${plan.title}`,
    maxTurns: 1,
  });

  return compiled.text.trim();
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

/** Backup wiki articles to managed_files table for DB recovery. */
async function backupWikiToDb(): Promise<void> {
  if (!fs.existsSync(WIKI_DIR)) return;

  const walkDir = (dir: string, prefix: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walkDir(path.join(dir, entry.name), `${prefix}${entry.name}/`);
      } else if (entry.name.endsWith(".md")) {
        const filePath = path.join(dir, entry.name);
        const dbPath = `wiki/${prefix}${entry.name}`;
        const content = fs.readFileSync(filePath, "utf-8");
        syncFileToDb(dbPath, content).catch(() => {});
      }
    }
  };

  walkDir(WIKI_DIR, "");
}

/** Build a summary of all available knowledge for the LLM planner. */
function buildKnowledgeSummary(
  entries: Array<{ category: string; key: string; value: string; confidence: number }>,
  contacts: Array<{ id: string; name: string; identities: unknown[] }>,
  existingPaths: string[],
): string {
  const lines: string[] = [];

  // Group user model by category
  const byCategory = new Map<string, typeof entries>();
  for (const e of entries) {
    const group = byCategory.get(e.category) ?? [];
    group.push(e);
    byCategory.set(e.category, group);
  }

  lines.push("USER MODEL ENTRIES:");
  for (const [category, items] of byCategory) {
    lines.push(`\n[${category}] (${items.length} entries):`);
    for (const item of items.slice(0, 15)) {
      const val = String(item.value).slice(0, 100);
      lines.push(`  - ${item.key}: ${val}`);
    }
    if (items.length > 15) lines.push(`  ... and ${items.length - 15} more`);
  }

  if (contacts.length > 0) {
    lines.push(`\nCONTACTS (${contacts.length}):`);
    for (const c of contacts.slice(0, 20)) {
      lines.push(`  - ${c.name} (${JSON.stringify(c.identities).slice(0, 100)})`);
    }
  }

  return lines.join("\n");
}
