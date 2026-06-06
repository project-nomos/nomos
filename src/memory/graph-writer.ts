/**
 * Self-wiring write path (Phase 2): turn the structured knowledge the extractor
 * already produces into typed graph nodes + edges — with ZERO additional LLM
 * calls (entity refs come from the extractor; relation types come from regex
 * verb-patterns). See BRAIN_PLAN.md §4 (write path).
 *
 * Guardrails against the mem0 "97.8% junk" failure mode:
 *   - a quality gate rejects attribute-only / noise / low-confidence entities
 *     BEFORE anything is written;
 *   - idempotent upserts (unique keys + GREATEST confidence) bound amplification
 *     so a repeated hallucination can't fan out into hundreds of rows.
 */

import { sql } from "kysely";
import { getKysely } from "../db/client.ts";
import type { TenantContext } from "../auth/tenant-context.ts";
import type { ExtractedKnowledge } from "./extractor.ts";
import {
  normalizeKey,
  upsertNode,
  upsertEdge,
  mergeNodeAttrs,
  reconcileOriginEdges,
  type UpsertEdgeInput,
} from "./graph.ts";

/** Minimum extractor confidence for a fact to enter the graph. */
const MIN_FACT_CONFIDENCE = 0.6;

/** Relations whose new value supersedes the old — trigger a contradiction check. */
const SINGLE_VALUED = new Set(["works_at", "located_in", "reports_to"]);

export type EntityClass =
  | { keep: false; reason: string }
  | { keep: true; isAttribute: true; attribute: "phone" | "email" | "url" }
  | { keep: true; isAttribute: false };

const PHONE_RE = /^[+(]?[\d][\d\s().-]{6,}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_RE = /^(https?:\/\/|www\.)/i;
const PURE_NUMBER_RE = /^[\d\s.,$%-]+$/;
const DATE_RE = /^\d{1,4}[/-]\d{1,2}([/-]\d{1,4})?$/;

const NOISE = new Set([
  "the user",
  "user",
  "assistant",
  "nomos",
  "you",
  "i",
  "me",
  "it",
  "this",
  "that",
  "they",
  "system",
  "the assistant",
]);

/**
 * Decide whether an extracted entity string becomes a node, an attribute, or is
 * dropped. Attributes (phone/email/url) get folded onto a related node instead
 * of becoming nodes of their own.
 */
export function classifyEntity(raw: string): EntityClass {
  const name = raw.trim();
  if (name.length < 2) return { keep: false, reason: "too_short" };
  if (NOISE.has(name.toLowerCase())) return { keep: false, reason: "noise" };
  if (EMAIL_RE.test(name)) return { keep: true, isAttribute: true, attribute: "email" };
  if (URL_RE.test(name)) return { keep: true, isAttribute: true, attribute: "url" };
  // Dates look like phone numbers (digits + separators) — reject them first.
  if (DATE_RE.test(name)) return { keep: false, reason: "date" };
  if (PHONE_RE.test(name) && /\d{7,}/.test(name.replace(/\D/g, "")))
    return { keep: true, isAttribute: true, attribute: "phone" };
  if (PURE_NUMBER_RE.test(name)) return { keep: false, reason: "pure_number" };
  return { keep: true, isAttribute: false };
}

/** Map of regex → relation type for zero-LLM edge typing over a fact sentence. */
const VERB_PATTERNS: Array<[RegExp, string]> = [
  [/\bworks?\s+(?:at|for)\b/i, "works_at"],
  [/\bemployed\s+(?:at|by)\b/i, "works_at"],
  [/\b(?:co-?)?founded\b/i, "founded"],
  [/\b(?:member|part)\s+of\b/i, "member_of"],
  [/\bbelongs\s+to\b/i, "member_of"],
  [/\b(?:manages|leads|runs)\b/i, "manages"],
  [/\breports\s+to\b/i, "reports_to"],
  [/\b(?:married|engaged|dating)\b/i, "related_to"],
  [/\b(?:meeting|scheduled|met)\s+with\b/i, "scheduled_with"],
  [/\blives?\s+in\b/i, "located_in"],
  [/\bbased\s+in\b/i, "located_in"],
  [/\b(?:prefers|likes|wants)\b/i, "prefers"],
];

/** Detect a relation type from a fact sentence; falls back to "related_to". */
export function detectRelType(text: string): string {
  for (const [re, rel] of VERB_PATTERNS) if (re.test(text)) return rel;
  return "related_to";
}

export interface IngestResult {
  nodesUpserted: number;
  edgesUpserted: number;
  rejected: number;
}

export interface IngestOptions {
  sourceIds?: string[];
  /** Override the minimum fact confidence (default 0.6). */
  minConfidence?: number;
}

/**
 * Resolve an entity name to a node id. People are resolved through the existing
 * `contacts` table so the identity graph stays the people-subset of the KG;
 * everything else becomes a `topic` node (deduped by canonical_key).
 */
async function resolveEntityNode(
  ctx: TenantContext,
  name: string,
  sourceIds: string[],
  confidence: number,
): Promise<string> {
  const db = getKysely();
  // Exact (case-insensitive) contact match → person node over the contact row.
  const contact = await sql<{ id: string; display_name: string }>`
    SELECT id::text, display_name FROM contacts
    WHERE lower(display_name) = ${name.toLowerCase()} AND user_id = ${ctx.userId}
    LIMIT 1
  `.execute(db);

  if (contact.rows[0]) {
    return upsertNode(ctx, {
      kind: "person",
      name: contact.rows[0].display_name,
      externalKind: "contact",
      externalRef: contact.rows[0].id,
      sourceIds,
      confidence: Math.max(confidence, 0.7),
    });
  }

  return upsertNode(ctx, { kind: "topic", name, sourceIds, confidence });
}

/**
 * Ingest the extractor's output into the knowledge graph. Only `facts` (the
 * relationship-bearing layer) are promoted to nodes/edges; preferences, values,
 * and decision-patterns stay in the user_model (the always-in-context core
 * memory), so the graph doesn't duplicate them.
 */
export async function ingestKnowledgeIntoGraph(
  ctx: TenantContext,
  knowledge: ExtractedKnowledge,
  opts: IngestOptions = {},
): Promise<IngestResult> {
  const sourceIds = opts.sourceIds ?? [];
  const minConf = opts.minConfidence ?? MIN_FACT_CONFIDENCE;
  const result: IngestResult = { nodesUpserted: 0, edgesUpserted: 0, rejected: 0 };

  for (const fact of knowledge.facts) {
    if (fact.confidence < minConf) {
      result.rejected++;
      continue;
    }

    // Quality gate + split entities into nodes vs folded attributes.
    const nodeNames: string[] = [];
    const attributes: Array<{ type: string; value: string }> = [];
    const seen = new Set<string>();
    for (const ent of fact.entities) {
      const cls = classifyEntity(ent);
      if (!cls.keep) {
        result.rejected++;
        continue;
      }
      if (cls.isAttribute) {
        attributes.push({ type: cls.attribute, value: ent.trim() });
      } else {
        const key = normalizeKey(ent);
        if (!seen.has(key)) {
          seen.add(key);
          nodeNames.push(ent.trim());
        }
      }
    }

    if (nodeNames.length === 0) continue;

    // Resolve entity nodes; fold attributes onto the first (subject) node.
    const ids: string[] = [];
    for (const name of nodeNames) {
      const id = await resolveEntityNode(ctx, name, sourceIds, fact.confidence);
      ids.push(id);
      result.nodesUpserted++;
    }
    if (attributes.length > 0) {
      const attrs: Record<string, string> = {};
      for (const a of attributes) attrs[a.type] = a.value;
      // Fold onto the actual resolved subject node (by id), whatever its kind.
      await mergeNodeAttrs(ctx, ids[0]!, attrs);
    }

    // Edges: subject (first node) → each other entity, typed by verb-pattern.
    const relType = detectRelType(fact.text);
    for (let i = 1; i < ids.length; i++) {
      const validAt = new Date();
      await upsertEdge(ctx, {
        srcId: ids[0]!,
        dstId: ids[i]!,
        relType,
        fact: fact.text,
        origin: "inferred",
        validAt,
        sourceIds,
        confidence: fact.confidence,
      });
      result.edgesUpserted++;

      // Bitemporal contradiction handling: a new single-valued value supersedes
      // the old one (invalidate, never delete). Off the critical path; non-fatal.
      if (SINGLE_VALUED.has(relType)) {
        try {
          const { checkContradictions } = await import("./graph-contradictions.ts");
          await checkContradictions(ctx, {
            srcId: ids[0]!,
            relType,
            dstId: ids[i]!,
            fact: fact.text,
            validAt,
          });
        } catch {
          /* non-fatal */
        }
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Wiki self-wiring: parse inline [[wikilinks]] into links_to edges (zero LLM).
// ---------------------------------------------------------------------------

/** Extract `[[Target]]` / `[[Target|alias]]` / `[[Target#heading]]` link targets. */
export function parseWikiLinks(content: string): string[] {
  const out = new Set<string>();
  const re = /\[\[([^\]]+)\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const inner = m[1]!.split("|")[0]!.split("#")[0]!.trim();
    if (inner) out.add(inner);
  }
  return [...out];
}

/**
 * Promote wiki articles into the graph and wire their inline [[links]] into
 * `links_to` edges. Reconciles per-article (gbrain scoped reconciliation), so a
 * re-sync replaces only that article's body edges. Idempotent.
 */
export async function syncWikiBodyLinks(ctx: TenantContext): Promise<{ edges: number }> {
  const db = getKysely();
  const articles = await sql<{ path: string; title: string; content: string }>`
    SELECT path, title, content FROM wiki_articles
  `.execute(db);

  const byKey = new Map<string, { path: string; title: string }>();
  for (const a of articles.rows) {
    byKey.set(a.title.toLowerCase(), a);
    byKey.set(a.path.toLowerCase(), a);
    byKey.set(a.path.toLowerCase().replace(/\.md$/, ""), a);
  }

  const wikiNode = (path: string, title: string) =>
    upsertNode(ctx, {
      kind: "wiki",
      name: title,
      canonicalKey: normalizeKey(path),
      externalKind: "wiki",
      externalRef: path,
      confidence: 0.8,
    });

  let edges = 0;
  for (const a of articles.rows) {
    const srcId = await wikiNode(a.path, a.title);
    const inputs: UpsertEdgeInput[] = [];
    for (const target of parseWikiLinks(a.content)) {
      const match = byKey.get(target.toLowerCase());
      const dstId = match
        ? await wikiNode(match.path, match.title)
        : await upsertNode(ctx, { kind: "topic", name: target, confidence: 0.4 });
      if (dstId !== srcId) {
        inputs.push({ srcId, dstId, relType: "links_to" });
      }
    }
    await reconcileOriginEdges(ctx, srcId, "body", inputs);
    edges += inputs.length;
  }
  return { edges };
}

/**
 * Promote wiki categories to MOC ("map of content") hub nodes and wire each
 * article into its category with a `part_of` edge — giving the graph navigable
 * hub-and-spoke topic clusters (Obsidian MOCs). Idempotent.
 */
export async function syncWikiMOCs(ctx: TenantContext): Promise<{ mocs: number; edges: number }> {
  const db = getKysely();
  const rows = await sql<{ path: string; title: string; category: string }>`
    SELECT path, title, category FROM wiki_articles WHERE category IS NOT NULL AND category <> 'index'
  `.execute(db);

  const categories = new Set<string>();
  let edges = 0;
  for (const a of rows.rows) {
    if (!a.category) continue;
    categories.add(a.category);
    const mocId = await upsertNode(ctx, {
      kind: "moc",
      name: a.category,
      canonicalKey: `moc:${a.category.toLowerCase()}`,
      confidence: 0.7,
    });
    const wikiId = await upsertNode(ctx, {
      kind: "wiki",
      name: a.title,
      canonicalKey: normalizeKey(a.path),
      externalKind: "wiki",
      externalRef: a.path,
      confidence: 0.8,
    });
    await upsertEdge(ctx, {
      srcId: wikiId,
      dstId: mocId,
      relType: "part_of",
      origin: "frontmatter",
    });
    edges++;
  }
  return { mocs: categories.size, edges };
}
