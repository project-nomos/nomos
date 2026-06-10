/**
 * Knowledge compiler -- Karpathy-style wiki compilation.
 *
 * Compiles the agent's accumulated knowledge into structured markdown wiki
 * articles. The compiled wiki is a DERIVED PROJECTION: the vault (the user's
 * authored memory) is the source of truth, and this distils it (plus the other
 * signals below) into browsable topic/contact articles. The LLM decides what
 * topics deserve articles based on the available data.
 *
 * Sources (vault first, it is the source of truth):
 *   - vault_notes: the user's authored long-term memory (the vault)
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
import { parseWikiLinks } from "./graph-writer.ts";
import { syncToDisk } from "./wiki-sync.ts";
import { syncFileToDb } from "../config/file-sync.ts";
import { isHosted } from "../config/mode.ts";
import { isRedisConfigured, getRedis, keyFor } from "../storage/redis.ts";
import { createLogger } from "../lib/logger.ts";
import { loadEnvConfigAsync, type NomosConfig } from "../config/env.ts";
import { parseInterval } from "../cron/scheduler.ts";

const log = createLogger("knowledge-compiler");

// Wiki output dir, overridable via NOMOS_WIKI_DIR and resolved at call time (not
// module load) so the eval can point it at a temp dir to stay out of ~/.nomos.
function wikiBaseDir(): string {
  return process.env.NOMOS_WIKI_DIR ?? path.join(homedir(), ".nomos", "wiki");
}

/** Per-owner lock path (power-user fallback when Redis is unavailable). Kept beside
 * the wiki dir so it follows NOMOS_WIKI_DIR. */
function lockFileFor(userId: string): string {
  return path.join(
    path.dirname(wikiBaseDir()),
    userId === "local" ? "wiki-compiler.lock" : `wiki-compiler.${userId}.lock`,
  );
}

/**
 * Acquire the per-owner compile slot. This is one guard doing two jobs, like the
 * old file lock: a cross-node MUTEX (two pods of one customer must not compile
 * concurrently) AND a cooldown (do not recompile within intervalMs). In
 * hosted (multi-node) it is a Redis key shared across the customer's pods; in
 * power-user it falls back to the local lock file. Returns false to skip.
 */
async function acquireCompileSlot(
  userId: string,
  force: boolean,
  intervalMs: number,
): Promise<boolean> {
  const cooldownSec = Math.floor(intervalMs / 1000);
  const stamp = new Date().toISOString();
  if (isRedisConfigured()) {
    const redis = getRedis();
    const key = keyFor("wiki-compile", userId);
    if (force) {
      await redis.set(key, stamp, "EX", cooldownSec);
      return true;
    }
    return (await redis.set(key, stamp, "EX", cooldownSec, "NX")) === "OK";
  }
  const lockFile = lockFileFor(userId);
  if (
    !force &&
    fs.existsSync(lockFile) &&
    Date.now() - fs.statSync(lockFile).mtimeMs < intervalMs
  ) {
    return false;
  }
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  fs.writeFileSync(lockFile, stamp);
  return true;
}

/** Re-anchor the cooldown to compile completion (mirrors the old end-of-run lock refresh). */
async function refreshCompileSlot(userId: string, intervalMs: number): Promise<void> {
  const cooldownSec = Math.floor(intervalMs / 1000);
  const stamp = new Date().toISOString();
  if (isRedisConfigured()) {
    await getRedis()
      .set(keyFor("wiki-compile", userId), stamp, "EX", cooldownSec)
      .catch(() => undefined);
    return;
  }
  const lockFile = lockFileFor(userId);
  if (fs.existsSync(lockFile)) fs.writeFileSync(lockFile, stamp);
}

// Fallback defaults, used when the corresponding app.wiki* config is unset/invalid.
const DEFAULT_MIN_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_MAX_ARTICLES_PER_RUN = 20;
const DEFAULT_COMPILE_MODEL = "claude-sonnet-4-6";

/** Resolved, ready-to-use wiki compile settings (every field has a concrete value). */
export interface ResolvedWikiConfig {
  enabled: boolean;
  /** Cooldown between compiles AND the seeded cron cadence, in ms. */
  intervalMs: number;
  model: string;
  maxArticles: number;
}

/**
 * Resolve wiki compile settings from NomosConfig, falling back to the constants
 * above for any unset/invalid value. wikiEnabled is coerced defensively: the
 * config store seeds booleans as JSON strings, so treat the string "false" (and
 * boolean false) as disabled and everything else as enabled.
 */
export function resolveWiki(config: Partial<NomosConfig>): ResolvedWikiConfig {
  const rawEnabled = config.wikiEnabled;
  const enabled = rawEnabled !== false && String(rawEnabled) !== "false";

  let intervalMs = DEFAULT_MIN_INTERVAL_MS;
  if (config.wikiCompileInterval) {
    try {
      intervalMs = parseInterval(config.wikiCompileInterval);
    } catch {
      // Invalid duration string -> keep the default cadence.
    }
  }

  const maxRaw = Number(config.wikiMaxArticlesPerRun);
  const maxArticles =
    Number.isFinite(maxRaw) && maxRaw > 0 ? Math.floor(maxRaw) : DEFAULT_MAX_ARTICLES_PER_RUN;

  const model = config.wikiCompileModel || DEFAULT_COMPILE_MODEL;

  return { enabled, intervalMs, model, maxArticles };
}

/**
 * Extract the first balanced JSON array from model text, ignoring brackets inside
 * strings. Robust to code fences and surrounding prose, where a greedy
 * `/\[[\s\S]*\]/` (first `[` to LAST `]`) captures junk and fails to parse.
 */
function extractJsonArray(text: string): string | null {
  const start = text.indexOf("[");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "[") depth++;
    else if (ch === "]" && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

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
export async function compileKnowledge(options?: {
  force?: boolean;
  userId?: string;
  /**
   * Override the resolved wiki settings (tests/eval). Merged over the
   * DB-resolved config, so a partial like `{ enabled: false }` flips one field.
   */
  wikiConfig?: Partial<ResolvedWikiConfig>;
}): Promise<CompilationResult> {
  // The vault is per-user (zero-trust on top of database-per-customer). Scope the
  // vault read to one tenant so a multi-user (per-person-brain) DB never blends
  // members' private notes into the shared compiled wiki. Defaults to the local
  // single-user install. Per-user wiki compilation in a multi-user DB is a
  // follow-up (it needs wiki_articles to carry user_id too).
  const userId = options?.userId ?? "local";

  // Resolve settings from config (DB > env > defaults), then apply any override.
  const wiki: ResolvedWikiConfig = {
    ...resolveWiki(await loadEnvConfigAsync()),
    ...(options?.wikiConfig ?? {}),
  };

  // Hard off-switch: a disabled wiki does no work, on every path (cron/CLI/eval).
  if (!wiki.enabled) {
    return {
      articlesCreated: 0,
      articlesUpdated: 0,
      errors: ["Skipped: wiki compilation disabled (app.wikiEnabled=false)"],
    };
  }

  // Cross-node mutex + cooldown (Redis in hosted, lock file in power-user).
  if (!(await acquireCompileSlot(userId, options?.force ?? false, wiki.intervalMs))) {
    return {
      articlesCreated: 0,
      articlesUpdated: 0,
      errors: ["Skipped: compiling elsewhere or too recent"],
    };
  }

  const result: CompilationResult = { articlesCreated: 0, articlesUpdated: 0, errors: [] };

  try {
    const sql = getDb();

    // 1. Gather all knowledge sources
    const userModelEntries = await sql`
      SELECT category, key, value::text as value, confidence
      FROM user_model
      WHERE user_id = ${userId} AND confidence >= 0.6
      ORDER BY confidence DESC
      LIMIT 200
    `;

    const recentConversations = await sql`
      SELECT text, path, created_at
      FROM memory_chunks
      WHERE user_id = ${userId} AND source = ${"conversation"}
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
      WHERE c.user_id = ${userId}
      GROUP BY c.id, c.display_name, c.autonomy
    `;

    // The vault is the SOURCE OF TRUTH: the user's authored long-term memory.
    // The compiled wiki is a projection over it (+ the other sources below), so
    // the curator reads the vault first.
    const vaultNotes = await sql`
      SELECT path, title, content
      FROM vault_notes
      WHERE user_id = ${userId}
      ORDER BY updated_at DESC
      LIMIT 100
    `;

    const existingArticles = await listArticles(userId);

    // 2. Ask the LLM what articles to create/update
    type ModelEntry = { category: string; key: string; value: string; confidence: number };
    type ContactRow = { id: string; name: string; identities: unknown[] };
    type VaultRow = { path: string; title: string; content: string };
    const entries = userModelEntries as unknown as ModelEntry[];
    const contactRows = contacts as unknown as ContactRow[];
    const vaultRows = vaultNotes as unknown as VaultRow[];

    const knowledgeSummary = buildKnowledgeSummary(entries, contactRows, vaultRows);

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

Maximum ${wiki.maxArticles} articles. Return [] if nothing is worth compiling.`,
      model: wiki.model,
      label: "wiki-plan",
      // Forks run with the full toolset, so a generation task can spend a turn on
      // a tool detour before answering; maxTurns:1 then dies with "Reached maximum
      // number of turns". Give the fork default (5) of headroom.
      maxTurns: 5,
    });

    let plans: Array<{ path: string; title: string; category: string; description: string }>;
    try {
      const jsonText = extractJsonArray(planResult.text);
      plans = jsonText ? JSON.parse(jsonText) : [];
    } catch {
      result.errors.push("Failed to parse article plan");
      return result;
    }

    if (plans.length === 0) {
      log.info("No articles to compile");
      return result;
    }

    log.info({ count: plans.length }, "Planning articles");

    // 3. Compile each article
    for (const plan of plans) {
      try {
        const existing = await getArticle(userId, plan.path);

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
          wiki.model,
        );

        const isNew = !existing;
        await upsertArticle(
          userId,
          plan.path,
          plan.title,
          article,
          plan.category,
          parseWikiLinks(article), // backlinks: the [[Other Article]] refs the LLM cross-linked
          wiki.model,
        );

        if (isNew) result.articlesCreated++;
        else result.articlesUpdated++;
      } catch (err) {
        result.errors.push(`${plan.path}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // 4. Update index
    await updateIndex(userId);

    // 5. Disk mirror is a power-user convenience (browse the wiki as files). In
    //    hosted the DB (wiki_articles, database-per-customer) is the shared source
    //    of truth read by the agent + clients; a per-node disk copy would just
    //    diverge across pods, so skip it (and its managed_files backup).
    if (!isHosted()) {
      await syncToDisk(userId);
      await backupWikiToDb();
    }

    // 7. Wire the (re)compiled wiki into the knowledge graph (zero-LLM [[links]]
    //    + MOC topic hubs).
    try {
      const { syncWikiBodyLinks, syncWikiMOCs } = await import("./graph-writer.ts");
      const { LOCAL_TENANT } = await import("../auth/tenant-context.ts");
      await syncWikiBodyLinks({ orgId: process.env.NOMOS_ORG_ID ?? "local", userId });
      await syncWikiMOCs({ orgId: process.env.NOMOS_ORG_ID ?? "local", userId });
    } catch (err) {
      log.debug({ err }, "Wiki→graph sync failed (non-fatal)");
    }

    log.info({ created: result.articlesCreated, updated: result.articlesUpdated }, "Done");
  } finally {
    await refreshCompileSlot(userId, wiki.intervalMs);
  }

  return result;
}

async function compileArticle(
  plan: { path: string; title: string; category: string },
  facts: Array<{ category: string; key: string; value: string; confidence: number }>,
  conversations: Array<{ text: string; path: string }>,
  contact: { name: string; identities: unknown[] } | undefined,
  existingContent: string | null,
  model: string,
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

When you mention another person, project, company, or topic that likely has its own wiki entry, wrap that name in double brackets like [[Name]] so the wiki cross-links. Only bracket proper nouns that are distinct entities, not generic words.

Return ONLY the markdown article content.`;

  const compiled = await runForkedAgent({
    prompt,
    model,
    label: `wiki-compile:${plan.title}`,
    // 5 turns of headroom so an article body that takes a tool detour still lands
    // its final answer (maxTurns:1 was dropping ~1 in 6 articles).
    maxTurns: 5,
  });

  return compiled.text.trim();
}

async function updateIndex(userId: string): Promise<void> {
  const articles = await listArticles(userId);
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

  await upsertArticle(userId, "_index.md", "Knowledge Wiki Index", indexLines.join("\n"), "index");
}

/** Backup wiki articles to managed_files table for DB recovery. */
async function backupWikiToDb(): Promise<void> {
  if (!fs.existsSync(wikiBaseDir())) return;

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

  walkDir(wikiBaseDir(), "");
}

/** Build a summary of all available knowledge for the LLM planner. */
function buildKnowledgeSummary(
  entries: Array<{ category: string; key: string; value: string; confidence: number }>,
  contacts: Array<{ id: string; name: string; identities: unknown[] }>,
  vaultNotes: Array<{ path: string; title: string; content: string }> = [],
): string {
  const lines: string[] = [];

  // The vault first: it is the user's authored memory, the source of truth the
  // compiled wiki should be derived from.
  if (vaultNotes.length > 0) {
    lines.push(`VAULT NOTES (the user's authored memory, source of truth) (${vaultNotes.length}):`);
    for (const n of vaultNotes.slice(0, 40)) {
      lines.push(`\n[${n.path}] ${n.title}`);
      lines.push(`  ${n.content.replace(/\s+/g, " ").slice(0, 300)}`);
    }
    if (vaultNotes.length > 40) lines.push(`  ... and ${vaultNotes.length - 40} more`);
    lines.push("");
  }

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
