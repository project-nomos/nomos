/**
 * Wiki lint -- the health-check pass Karpathy's pattern calls for. The compiler
 * GENERATES articles; the linter VALIDATES the wiki and reports what's wrong:
 *
 *   - orphan articles   (no inbound [[links]] from any other article)
 *   - dangling links    ([[Target]] mentioned but no article exists -> missing page)
 *   - superseded facts   (kg_edges.invalid_at -- newer info replaced an older claim)
 *
 * The report is written back into the wiki as `_lint.md` (an article, category
 * "lint") so it lives in the DB and works in BOTH modes: hosted reads it from the
 * DB, power-user also gets it mirrored to ~/.nomos/wiki. Runs on the __wiki_lint__
 * cron sentinel (default 24h), per owner, off/cooldown-gated like the compiler.
 */

import { sql } from "kysely";
import { getKysely } from "../db/client.ts";
import { listArticles, upsertArticle } from "../db/wiki.ts";
import { syncToDisk } from "./wiki-sync.ts";
import { isHosted } from "../config/mode.ts";
import { createLogger } from "../lib/logger.ts";
import { loadEnvConfigAsync, type NomosConfig } from "../config/env.ts";
import { parseInterval } from "../cron/scheduler.ts";
import { acquireCompileSlot, refreshCompileSlot } from "./knowledge-compiler.ts";

const log = createLogger("wiki-lint");

const DEFAULT_LINT_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h

export interface ResolvedWikiLintConfig {
  enabled: boolean;
  intervalMs: number;
}

/**
 * Resolve lint settings from NomosConfig, mirroring resolveWiki: fall back to the
 * constant for an unset/invalid interval, and coerce the seeded JSON-string
 * "false" (not just boolean false) to disabled.
 */
export function resolveWikiLint(config: Partial<NomosConfig>): ResolvedWikiLintConfig {
  const rawEnabled = config.wikiLintEnabled;
  const enabled = rawEnabled !== false && String(rawEnabled) !== "false";

  let intervalMs = DEFAULT_LINT_INTERVAL_MS;
  if (config.wikiLintInterval) {
    try {
      intervalMs = parseInterval(config.wikiLintInterval);
    } catch {
      // invalid duration string -> keep the default cadence
    }
  }
  return { enabled, intervalMs };
}

/** Meta articles the linter neither reports on nor treats as knowledge. */
const META_CATEGORIES = new Set(["index", "lint"]);

/** The minimal article shape the pure detectors need (keeps them DB-free + testable). */
export interface LintArticle {
  path: string;
  title: string;
  category: string;
  backlinks: string[];
}

/** The resolvable keys an article can be referenced by (title, path, path w/o .md). */
function articleKeys(a: LintArticle): string[] {
  return [a.title.toLowerCase(), a.path.toLowerCase(), a.path.toLowerCase().replace(/\.md$/, "")];
}

/**
 * Orphans: articles that NO other article links to. Pure. Excludes meta articles.
 * "No inbound links" is Karpathy's orphan definition; a fresh hub with only
 * outbound links still counts (it's worth surfacing until something references it).
 */
export function findOrphans(articles: LintArticle[]): LintArticle[] {
  const referenced = new Set<string>();
  for (const a of articles) {
    for (const target of a.backlinks) referenced.add(target.toLowerCase());
  }
  return articles.filter(
    (a) => !META_CATEGORIES.has(a.category) && !articleKeys(a).some((k) => referenced.has(k)),
  );
}

export interface DanglingLink {
  target: string;
  from: string;
}

/**
 * Dangling links: a [[Target]] that resolves to no article (a concept mentioned
 * but lacking its own page -- Karpathy's missing-page signal). Pure. Deduped by
 * (target, from).
 */
export function findDanglingLinks(articles: LintArticle[]): DanglingLink[] {
  const resolvable = new Set<string>();
  for (const a of articles) {
    if (META_CATEGORIES.has(a.category)) continue;
    for (const k of articleKeys(a)) resolvable.add(k);
  }
  const seen = new Set<string>();
  const out: DanglingLink[] = [];
  for (const a of articles) {
    for (const target of a.backlinks) {
      if (resolvable.has(target.toLowerCase())) continue;
      const dedup = `${target.toLowerCase()}|${a.path}`;
      if (seen.has(dedup)) continue;
      seen.add(dedup);
      out.push({ target, from: a.path });
    }
  }
  return out;
}

interface SupersededRow {
  fact: string;
  invalidAt: Date;
}

/** All facts a newer one has already superseded (kg_edges.invalid_at), owner-scoped. */
async function fetchSupersededFacts(userId: string, limit = 25): Promise<SupersededRow[]> {
  try {
    const db = getKysely();
    const res = await sql<{ fact: string | null; invalid_at: Date }>`
      SELECT fact, invalid_at
      FROM kg_edges
      WHERE user_id = ${userId} AND invalid_at IS NOT NULL AND fact IS NOT NULL
      ORDER BY invalid_at DESC
      LIMIT ${limit}
    `.execute(db);
    return res.rows
      .filter((r): r is { fact: string; invalid_at: Date } => Boolean(r.fact))
      .map((r) => ({ fact: r.fact, invalidAt: r.invalid_at }));
  } catch {
    return [];
  }
}

/** Render the deterministic lint report markdown. */
export function renderLintReport(input: {
  articleCount: number;
  orphans: LintArticle[];
  dangling: DanglingLink[];
  superseded: SupersededRow[];
}): string {
  const { articleCount, orphans, dangling, superseded } = input;
  const lines: string[] = ["# Wiki Lint Report", ""];
  lines.push(
    `_${articleCount} article(s) · ${orphans.length} orphan(s) · ${dangling.length} dangling link(s) · ${superseded.length} superseded fact(s)_`,
    "",
  );

  lines.push(`## Orphan articles — no inbound links (${orphans.length})`);
  if (orphans.length === 0) lines.push("- None. Every article is linked from somewhere.");
  else for (const a of orphans) lines.push(`- [${a.title}](${a.path})`);
  lines.push("");

  lines.push(`## Missing pages — mentioned but no article (${dangling.length})`);
  if (dangling.length === 0) lines.push("- None. Every [[link]] resolves to an article.");
  else for (const d of dangling) lines.push(`- [[${d.target}]] — referenced by \`${d.from}\``);
  lines.push("");

  lines.push(`## Superseded facts — newer info replaced these (${superseded.length})`);
  if (superseded.length === 0) lines.push("- None recorded.");
  else
    for (const s of superseded)
      lines.push(`- ${s.fact} _(superseded ${new Date(s.invalidAt).toISOString().slice(0, 10)})_`);
  lines.push("");

  if (dangling.length > 0) {
    lines.push("## Suggested follow-ups");
    const uniqueTargets = [...new Set(dangling.map((d) => d.target))];
    for (const t of uniqueTargets.slice(0, 20))
      lines.push(`- Create or gather sources for [[${t}]]`);
    lines.push("");
  }

  return lines.join("\n");
}

export interface LintResult {
  orphans: number;
  dangling: number;
  superseded: number;
  wrote: boolean;
  skipped?: string;
}

/**
 * Run the wiki lint pass for one owner: detect orphans + dangling links +
 * superseded facts, write the `_lint.md` report article. Off-switch + cooldown
 * gated (shares the compiler's Redis/lockfile slot mechanism under the "wiki-lint"
 * namespace, so it is correct across nodes in hosted and single-node in power-user).
 */
export async function lintWiki(options?: {
  force?: boolean;
  userId?: string;
  /** Override resolved lint settings (tests/eval). Merged over DB-resolved config. */
  lintConfig?: Partial<ResolvedWikiLintConfig>;
}): Promise<LintResult> {
  const userId = options?.userId ?? "local";
  const cfg: ResolvedWikiLintConfig = {
    ...resolveWikiLint(await loadEnvConfigAsync()),
    ...options?.lintConfig,
  };

  if (!cfg.enabled) {
    return { orphans: 0, dangling: 0, superseded: 0, wrote: false, skipped: "disabled" };
  }
  if (!(await acquireCompileSlot(userId, options?.force ?? false, cfg.intervalMs, "wiki-lint"))) {
    return { orphans: 0, dangling: 0, superseded: 0, wrote: false, skipped: "cooldown" };
  }

  try {
    const rows = await listArticles(userId);
    const articles: LintArticle[] = rows.map((a) => ({
      path: a.path,
      title: a.title,
      category: a.category,
      backlinks: a.backlinks ?? [],
    }));
    const knowledge = articles.filter((a) => !META_CATEGORIES.has(a.category));

    const orphans = findOrphans(articles);
    const dangling = findDanglingLinks(articles);
    const superseded = await fetchSupersededFacts(userId);

    const body = renderLintReport({
      articleCount: knowledge.length,
      orphans,
      dangling,
      superseded,
    });

    // Write the report as an article (category "lint") -- DB-resident, so it works
    // in hosted; disk mirror only in power-user (the DB is the source of truth).
    await upsertArticle(userId, "_lint.md", "Wiki Lint Report", body, "lint");
    if (!isHosted()) await syncToDisk(userId).catch(() => {});

    log.info(
      { userId, orphans: orphans.length, dangling: dangling.length, superseded: superseded.length },
      "Wiki lint complete",
    );
    return {
      orphans: orphans.length,
      dangling: dangling.length,
      superseded: superseded.length,
      wrote: true,
    };
  } finally {
    await refreshCompileSlot(userId, cfg.intervalMs, "wiki-lint");
  }
}
