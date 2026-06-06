/**
 * Knowledge graph (BRAIN) — typed, bitemporal entity/edge overlay over the
 * existing memory stack. See BRAIN_PLAN.md.
 *
 * Storage: two Postgres tables (kg_nodes, kg_edges) traversed with recursive
 * CTEs. No Apache AGE, no GraphQL — the agent reads through MCP tools, the
 * Settings UI / mobile read through a {nodes, edges} projection.
 *
 * Tenancy: every function takes a `TenantContext` and scopes on `user_id`,
 * INCLUDING inside the recursive-CTE join, so a traversal can never cross into
 * another person's subgraph. Power-user installs use `LOCAL_TENANT`.
 */

import { sql } from "kysely";
import { getKysely } from "../db/client.ts";
import { cosineDistance } from "../db/sql-helpers.ts";
import { LOCAL_TENANT, type TenantContext } from "../auth/tenant-context.ts";

/** Sentinel for "no writing node" — keeps the plain UNIQUE working (no PG15 NULLS NOT DISTINCT). */
export const NIL_NODE = "00000000-0000-0000-0000-000000000000";

/** Canonical node kinds. Open-ended — a string outside this set is allowed. */
export const NODE_KINDS = [
  "person",
  "project",
  "topic",
  "decision",
  "value",
  "event",
  "org",
  "wiki",
  "moc",
  "chunk",
] as const;

/** Starting relation taxonomy (personal/relationship brain) + dynamic fallback. */
export const REL_TYPES = [
  "works_at",
  "member_of",
  "mentions",
  "links_to",
  "part_of",
  "related_to",
  "derived_from",
  "contradicts",
  "prefers",
  "decided",
  "scheduled_with",
  "semantic_sibling",
] as const;

export type EdgeOrigin =
  | "explicit"
  | "frontmatter"
  | "body"
  | "mentions"
  | "inferred"
  | "semantic"
  | "manual";

export type Direction = "in" | "out" | "both";

export interface GraphNode {
  id: string;
  kind: string;
  name: string;
  canonicalKey: string;
  aliases: string[];
  summary: string | null;
  externalKind: string | null;
  externalRef: string | null;
  attrs: Record<string, unknown>;
  confidence: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface GraphEdge {
  id: string;
  srcId: string;
  dstId: string;
  relType: string;
  fact: string | null;
  origin: string;
  weight: number;
  validAt: Date;
  invalidAt: Date | null;
  confidence: number;
  attrs: Record<string, unknown>;
}

export interface Subgraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

// JSON Canvas (jsoncanvas.org/spec/1.0) — open, MIT, LLM-readable export format.
export interface JsonCanvasNode {
  id: string;
  type: "text";
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color?: string;
}
export interface JsonCanvasEdge {
  id: string;
  fromNode: string;
  toNode: string;
  label?: string;
}
export interface JsonCanvas {
  nodes: JsonCanvasNode[];
  edges: JsonCanvasEdge[];
}

const CANVAS_COLORS: Record<string, string> = {
  person: "#89b4fa",
  org: "#f9e2af",
  project: "#a6e3a1",
  topic: "#cba6f7",
  decision: "#fab387",
  value: "#f38ba8",
  event: "#94e2d5",
  wiki: "#74c7ec",
  moc: "#f5c2e7",
};

/**
 * Serialize a subgraph to the JSON Canvas spec, laid out on a circle (positions
 * aren't stored server-side). A portable, model-readable snapshot any tool — or
 * the LLM itself — can read/write.
 */
export function subgraphToCanvas(sub: Subgraph): JsonCanvas {
  const n = sub.nodes.length;
  const radius = Math.max(240, n * 34);
  const nodes: JsonCanvasNode[] = sub.nodes.map((node, i) => {
    const ang = (i / Math.max(n, 1)) * Math.PI * 2;
    return {
      id: node.id,
      type: "text",
      text: `${node.name}\n[${node.kind}]`,
      x: Math.round(Math.cos(ang) * radius),
      y: Math.round(Math.sin(ang) * radius),
      width: 220,
      height: 60,
      color: CANVAS_COLORS[node.kind],
    };
  });
  const edges: JsonCanvasEdge[] = sub.edges.map((e) => ({
    id: e.id,
    fromNode: e.srcId,
    toNode: e.dstId,
    label: e.relType.replace(/_/g, " "),
  }));
  return { nodes, edges };
}

export interface UpsertNodeInput {
  kind: string;
  name: string;
  /** Defaults to the normalized (lowercased, trimmed) name. */
  canonicalKey?: string;
  aliases?: string[];
  summary?: string | null;
  embedding?: number[] | null;
  externalKind?: string | null;
  externalRef?: string | null;
  attrs?: Record<string, unknown>;
  sourceIds?: string[];
  confidence?: number;
}

export interface UpsertEdgeInput {
  srcId: string;
  dstId: string;
  relType: string;
  fact?: string | null;
  origin?: EdgeOrigin;
  /** The writing node, for scoped reconciliation. Defaults to NIL_NODE. */
  originNode?: string;
  weight?: number;
  validAt?: Date;
  attrs?: Record<string, unknown>;
  sourceIds?: string[];
  confidence?: number;
}

export interface NeighborOptions {
  depth?: number; // hops, hard-capped at MAX_DEPTH
  relTypes?: string[];
  direction?: Direction;
  validOnly?: boolean;
  limit?: number; // max nodes returned
  /** Bitemporal "as of" — only edges valid at this instant ("what I believed then"). */
  asOf?: Date;
}

/** Hard depth cap to bound recursive-CTE fan-out. */
export const MAX_DEPTH = 3;
const MAX_PATH_DEPTH = 5;

export function normalizeKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

function vectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

const NODE_COLUMNS = [
  "id",
  "kind",
  "name",
  "canonical_key",
  "aliases",
  "summary",
  "external_kind",
  "external_ref",
  "attrs",
  "confidence",
  "created_at",
  "updated_at",
] as const;

const EDGE_COLUMNS = [
  "id",
  "src_id",
  "dst_id",
  "rel_type",
  "fact",
  "origin",
  "weight",
  "valid_at",
  "invalid_at",
  "confidence",
  "attrs",
] as const;

interface NodeRow {
  id: string;
  kind: string;
  name: string;
  canonical_key: string;
  aliases: string[];
  summary: string | null;
  external_kind: string | null;
  external_ref: string | null;
  attrs: Record<string, unknown>;
  confidence: number;
  created_at: Date;
  updated_at: Date;
}

interface EdgeRow {
  id: string;
  src_id: string;
  dst_id: string;
  rel_type: string;
  fact: string | null;
  origin: string;
  weight: number;
  valid_at: Date;
  invalid_at: Date | null;
  confidence: number;
  attrs: Record<string, unknown>;
}

function toNode(r: NodeRow): GraphNode {
  return {
    id: r.id,
    kind: r.kind,
    name: r.name,
    canonicalKey: r.canonical_key,
    aliases: r.aliases ?? [],
    summary: r.summary,
    externalKind: r.external_kind,
    externalRef: r.external_ref,
    attrs: r.attrs ?? {},
    confidence: r.confidence,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toEdge(r: EdgeRow): GraphEdge {
  return {
    id: r.id,
    srcId: r.src_id,
    dstId: r.dst_id,
    relType: r.rel_type,
    fact: r.fact,
    origin: r.origin,
    weight: r.weight,
    validAt: r.valid_at,
    invalidAt: r.invalid_at,
    confidence: r.confidence,
    attrs: r.attrs ?? {},
  };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/** Create or merge a node. Dedup key is (user_id, kind, canonical_key). Returns the node id. */
export async function upsertNode(ctx: TenantContext, input: UpsertNodeInput): Promise<string> {
  const db = getKysely();
  const canonicalKey = input.canonicalKey ?? normalizeKey(input.name);
  const embeddingStr =
    input.embedding && input.embedding.length ? vectorLiteral(input.embedding) : null;

  const row = await db
    .insertInto("kg_nodes")
    .values({
      kind: input.kind,
      name: input.name,
      canonical_key: canonicalKey,
      aliases: input.aliases ?? [],
      summary: input.summary ?? null,
      embedding: embeddingStr ? sql`${embeddingStr}::vector` : null,
      external_kind: input.externalKind ?? null,
      external_ref: input.externalRef ?? null,
      // `::text::jsonb` stores "{}" as an OBJECT. postgres-js JSON-encodes string
      // params, so a plain `$1::jsonb` yields a string SCALAR and the `||` merge
      // below would wrap operands into an array. The text round-trip fixes that.
      attrs: sql`${JSON.stringify(input.attrs ?? {})}::text::jsonb`,
      source_ids: input.sourceIds ?? [],
      confidence: input.confidence ?? 0.5,
      user_id: ctx.userId,
    })
    .onConflict((oc) =>
      oc.columns(["user_id", "kind", "canonical_key"]).doUpdateSet({
        name: sql`EXCLUDED.name`,
        aliases: sql`ARRAY(SELECT DISTINCT unnest(kg_nodes.aliases || EXCLUDED.aliases))`,
        summary: sql`COALESCE(EXCLUDED.summary, kg_nodes.summary)`,
        embedding: sql`COALESCE(EXCLUDED.embedding, kg_nodes.embedding)`,
        external_kind: sql`COALESCE(EXCLUDED.external_kind, kg_nodes.external_kind)`,
        external_ref: sql`COALESCE(EXCLUDED.external_ref, kg_nodes.external_ref)`,
        // Guard against legacy non-object attrs so the merge can't yield an array.
        attrs: sql`(CASE WHEN jsonb_typeof(kg_nodes.attrs) = 'object' THEN kg_nodes.attrs ELSE '{}'::jsonb END) || EXCLUDED.attrs`,
        source_ids: sql`ARRAY(SELECT DISTINCT unnest(kg_nodes.source_ids || EXCLUDED.source_ids))`,
        confidence: sql`GREATEST(kg_nodes.confidence, EXCLUDED.confidence)`,
        updated_at: sql`now()`,
      }),
    )
    .returning("id")
    .executeTakeFirstOrThrow();

  return row.id;
}

/** Create or revive an edge. Dedup key is (user_id, src, dst, rel_type, origin, origin_node). */
export async function upsertEdge(ctx: TenantContext, input: UpsertEdgeInput): Promise<string> {
  const db = getKysely();
  const row = await db
    .insertInto("kg_edges")
    .values({
      src_id: input.srcId,
      dst_id: input.dstId,
      rel_type: input.relType,
      fact: input.fact ?? null,
      origin: input.origin ?? "explicit",
      origin_node: input.originNode ?? NIL_NODE,
      weight: input.weight ?? 1.0,
      valid_at: input.validAt ?? new Date(),
      attrs: sql`${JSON.stringify(input.attrs ?? {})}::text::jsonb`,
      source_ids: input.sourceIds ?? [],
      confidence: input.confidence ?? 0.5,
      user_id: ctx.userId,
    })
    .onConflict((oc) =>
      oc.columns(["user_id", "src_id", "dst_id", "rel_type", "origin", "origin_node"]).doUpdateSet({
        fact: sql`COALESCE(EXCLUDED.fact, kg_edges.fact)`,
        weight: sql`EXCLUDED.weight`,
        attrs: sql`(CASE WHEN jsonb_typeof(kg_edges.attrs) = 'object' THEN kg_edges.attrs ELSE '{}'::jsonb END) || EXCLUDED.attrs`,
        source_ids: sql`ARRAY(SELECT DISTINCT unnest(kg_edges.source_ids || EXCLUDED.source_ids))`,
        confidence: sql`GREATEST(kg_edges.confidence, EXCLUDED.confidence)`,
        // Re-asserting a fact revives a previously superseded edge.
        invalid_at: sql`NULL`,
        expired_at: sql`NULL`,
      }),
    )
    .returning("id")
    .executeTakeFirstOrThrow();

  return row.id;
}

/** Merge a JSONB attrs patch onto a node by id (used to fold phone/email attributes). */
export async function mergeNodeAttrs(
  ctx: TenantContext,
  nodeId: string,
  attrs: Record<string, unknown>,
): Promise<void> {
  if (Object.keys(attrs).length === 0) return;
  const db = getKysely();
  await db
    .updateTable("kg_nodes")
    .set({
      attrs: sql`(CASE WHEN jsonb_typeof(kg_nodes.attrs) = 'object' THEN kg_nodes.attrs ELSE '{}'::jsonb END) || ${JSON.stringify(attrs)}::text::jsonb`,
      updated_at: sql`now()`,
    })
    .where("id", "=", nodeId)
    .where("user_id", "=", ctx.userId)
    .execute();
}

/** Supersede an edge: mark it invalid as of `invalidAt` (bitemporal — never deleted). */
export async function invalidateEdge(
  ctx: TenantContext,
  edgeId: string,
  invalidAt: Date = new Date(),
): Promise<void> {
  const db = getKysely();
  await db
    .updateTable("kg_edges")
    .set({ invalid_at: invalidAt, expired_at: sql`now()` })
    .where("id", "=", edgeId)
    .where("user_id", "=", ctx.userId)
    .where("invalid_at", "is", null)
    .execute();
}

/**
 * Scoped reconciliation (gbrain pattern): replace exactly the edges a given
 * writing node previously emitted with a given origin, leaving manual and
 * other-origin edges untouched. Used by the Phase 2 self-wiring extractor.
 */
export async function reconcileOriginEdges(
  ctx: TenantContext,
  originNode: string,
  origin: EdgeOrigin,
  edges: UpsertEdgeInput[],
): Promise<void> {
  const db = getKysely();
  await db
    .deleteFrom("kg_edges")
    .where("user_id", "=", ctx.userId)
    .where("origin_node", "=", originNode)
    .where("origin", "=", origin)
    .execute();
  for (const e of edges) {
    await upsertEdge(ctx, { ...e, origin, originNode });
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getNode(ctx: TenantContext, id: string): Promise<GraphNode | undefined> {
  const db = getKysely();
  const row = await db
    .selectFrom("kg_nodes")
    .select(NODE_COLUMNS)
    .where("id", "=", id)
    .where("user_id", "=", ctx.userId)
    .executeTakeFirst();
  return row ? toNode(row as unknown as NodeRow) : undefined;
}

export async function getNodeByExternal(
  ctx: TenantContext,
  externalKind: string,
  externalRef: string,
): Promise<GraphNode | undefined> {
  const db = getKysely();
  const row = await db
    .selectFrom("kg_nodes")
    .select(NODE_COLUMNS)
    .where("external_kind", "=", externalKind)
    .where("external_ref", "=", externalRef)
    .where("user_id", "=", ctx.userId)
    .executeTakeFirst();
  return row ? toNode(row as unknown as NodeRow) : undefined;
}

/**
 * Resolve a natural-language query to nodes via trigram name similarity (+
 * alias match), optionally blended with embedding cosine when an embedding is
 * supplied. Always scoped to the caller's user_id.
 */
export async function searchNodes(
  ctx: TenantContext,
  query: string,
  opts: { limit?: number; embedding?: number[]; kinds?: string[] } = {},
): Promise<GraphNode[]> {
  const db = getKysely();
  const limit = Math.min(opts.limit ?? 10, 50);

  let q = db
    .selectFrom("kg_nodes")
    .select(NODE_COLUMNS)
    .where("user_id", "=", ctx.userId)
    // pg_trgm similarity (`%`), substring, or exact alias match.
    .where(
      sql<boolean>`(name % ${query} OR name ILIKE ${`%${query}%`} OR ${query} = ANY(aliases))`,
    );

  if (opts.kinds && opts.kinds.length) {
    q = q.where("kind", "in", opts.kinds);
  }

  if (opts.embedding && opts.embedding.length) {
    // Rank by embedding cosine when available; trigram is the filter.
    q = q.where("embedding", "is not", null).orderBy(cosineDistance("embedding", opts.embedding));
  } else {
    q = q.orderBy(sql`similarity(name, ${query})`, "desc");
  }

  const rows = await q.limit(limit).execute();
  return (rows as unknown as NodeRow[]).map(toNode);
}

/** Direction-aware edge-match fragment for the recursive walk. */
function dirCond(direction: Direction) {
  if (direction === "out") return sql`e.src_id = r.id`;
  if (direction === "in") return sql`e.dst_id = r.id`;
  return sql`(e.src_id = r.id OR e.dst_id = r.id)`;
}

/**
 * Depth-bounded ego-network (Obsidian "Local Graph"): the subgraph reachable
 * within `depth` hops of `startId`. The recursive join filters `user_id` at
 * EVERY hop so the walk cannot leave the caller's brain.
 */
export async function neighborhood(
  ctx: TenantContext,
  startId: string,
  opts: NeighborOptions = {},
): Promise<Subgraph> {
  const db = getKysely();
  const depth = Math.min(Math.max(opts.depth ?? 2, 0), MAX_DEPTH);
  const direction = opts.direction ?? "both";
  const validOnly = opts.validOnly ?? true;
  const limit = Math.min(opts.limit ?? 200, 1000);

  const relCond =
    opts.relTypes && opts.relTypes.length ? sql`AND e.rel_type = ANY(${opts.relTypes})` : sql``;
  const validCond = opts.asOf
    ? sql`AND e.valid_at <= ${opts.asOf} AND (e.invalid_at IS NULL OR e.invalid_at > ${opts.asOf})`
    : validOnly
      ? sql`AND e.invalid_at IS NULL`
      : sql``;

  const reach = await sql<{ id: string }>`
    WITH RECURSIVE reach(id, depth) AS (
      SELECT id, 0 FROM kg_nodes WHERE id = ${startId} AND user_id = ${ctx.userId}
      UNION
      SELECT (CASE WHEN e.src_id = r.id THEN e.dst_id ELSE e.src_id END), r.depth + 1
      FROM reach r
      JOIN kg_edges e
        ON ${dirCond(direction)}
       AND e.user_id = ${ctx.userId}
       ${relCond}
       ${validCond}
      WHERE r.depth < ${depth}
    )
    SELECT DISTINCT id FROM reach LIMIT ${limit}
  `.execute(db);

  const ids = reach.rows.map((r) => r.id);
  if (ids.length === 0) return { nodes: [], edges: [] };

  return fetchSubgraph(ctx, ids, { relTypes: opts.relTypes, validOnly, asOf: opts.asOf });
}

/**
 * Shortest typed path between two nodes ("how is A connected to B"). Returns
 * the path as a subgraph, or null if unreachable within MAX_PATH_DEPTH.
 */
export async function shortestPath(
  ctx: TenantContext,
  fromId: string,
  toId: string,
  opts: { maxDepth?: number; validOnly?: boolean } = {},
): Promise<Subgraph | null> {
  const db = getKysely();
  const maxDepth = Math.min(Math.max(opts.maxDepth ?? 4, 1), MAX_PATH_DEPTH);
  const validOnly = opts.validOnly ?? true;
  const validCond = validOnly ? sql`AND e.invalid_at IS NULL` : sql``;

  const res = await sql<{ npath: string[]; epath: string[] }>`
    WITH RECURSIVE walk(id, depth, npath, epath) AS (
      SELECT id, 0, ARRAY[id], ARRAY[]::uuid[]
      FROM kg_nodes WHERE id = ${fromId} AND user_id = ${ctx.userId}
      UNION ALL
      SELECT
        (CASE WHEN e.src_id = w.id THEN e.dst_id ELSE e.src_id END),
        w.depth + 1,
        w.npath || (CASE WHEN e.src_id = w.id THEN e.dst_id ELSE e.src_id END),
        w.epath || e.id
      FROM walk w
      JOIN kg_edges e
        ON (e.src_id = w.id OR e.dst_id = w.id)
       AND e.user_id = ${ctx.userId}
       ${validCond}
      WHERE w.depth < ${maxDepth}
        AND NOT (CASE WHEN e.src_id = w.id THEN e.dst_id ELSE e.src_id END) = ANY(w.npath)
    )
    SELECT npath, epath FROM walk WHERE id = ${toId} ORDER BY depth LIMIT 1
  `.execute(db);

  const hit = res.rows[0];
  if (!hit) return null;

  const nodeRows = await db
    .selectFrom("kg_nodes")
    .select(NODE_COLUMNS)
    .where("id", "in", hit.npath)
    .where("user_id", "=", ctx.userId)
    .execute();
  const edgeRows = hit.epath.length
    ? await db
        .selectFrom("kg_edges")
        .select(EDGE_COLUMNS)
        .where("id", "in", hit.epath)
        .where("user_id", "=", ctx.userId)
        .execute()
    : [];

  // Re-order to the actual traversal sequence (the IN-list fetch is unordered).
  const nodeById = new Map((nodeRows as unknown as NodeRow[]).map((r) => [r.id, toNode(r)]));
  const edgeById = new Map((edgeRows as unknown as EdgeRow[]).map((r) => [r.id, toEdge(r)]));
  return {
    nodes: hit.npath.map((id) => nodeById.get(id)).filter((n): n is GraphNode => n != null),
    edges: hit.epath.map((id) => edgeById.get(id)).filter((e): e is GraphEdge => e != null),
  };
}

/**
 * Global projection for the visualization / mobile: nodes (capped) + the edges
 * among them. Scoped to the caller's user_id.
 */
export async function getProjection(
  ctx: TenantContext,
  opts: { kinds?: string[]; relTypes?: string[]; validOnly?: boolean; limit?: number } = {},
): Promise<Subgraph> {
  const db = getKysely();
  const limit = Math.min(opts.limit ?? 500, 5000);

  let nq = db
    .selectFrom("kg_nodes")
    .select(NODE_COLUMNS)
    .where("user_id", "=", ctx.userId)
    .orderBy("updated_at", "desc")
    .limit(limit);
  if (opts.kinds && opts.kinds.length) nq = nq.where("kind", "in", opts.kinds);

  const nodeRows = (await nq.execute()) as unknown as NodeRow[];
  const ids = nodeRows.map((n) => n.id);
  if (ids.length === 0) return { nodes: [], edges: [] };

  // Edges whose BOTH endpoints are in the projected node set.
  let eq = db
    .selectFrom("kg_edges")
    .select(EDGE_COLUMNS)
    .where("user_id", "=", ctx.userId)
    .where("src_id", "in", ids)
    .where("dst_id", "in", ids);
  if (opts.validOnly ?? true) eq = eq.where("invalid_at", "is", null);
  if (opts.relTypes && opts.relTypes.length) eq = eq.where("rel_type", "in", opts.relTypes);
  const edgeRows = (await eq.execute()) as unknown as EdgeRow[];

  return { nodes: nodeRows.map(toNode), edges: edgeRows.map(toEdge) };
}

/** Fetch the nodes for `ids` and the edges whose BOTH endpoints are in `ids`. */
async function fetchSubgraph(
  ctx: TenantContext,
  ids: string[],
  opts: { relTypes?: string[]; validOnly?: boolean; asOf?: Date },
): Promise<Subgraph> {
  const db = getKysely();
  const nodeRows = await db
    .selectFrom("kg_nodes")
    .select(NODE_COLUMNS)
    .where("id", "in", ids)
    .where("user_id", "=", ctx.userId)
    .execute();

  let eq = db
    .selectFrom("kg_edges")
    .select(EDGE_COLUMNS)
    .where("user_id", "=", ctx.userId)
    .where("src_id", "in", ids)
    .where("dst_id", "in", ids);
  if (opts.asOf) {
    eq = eq
      .where("valid_at", "<=", opts.asOf)
      .where((eb) => eb.or([eb("invalid_at", "is", null), eb("invalid_at", ">", opts.asOf!)]));
  } else if (opts.validOnly ?? true) {
    eq = eq.where("invalid_at", "is", null);
  }
  if (opts.relTypes && opts.relTypes.length) eq = eq.where("rel_type", "in", opts.relTypes);

  const edgeRows = await eq.execute();
  return {
    nodes: (nodeRows as unknown as NodeRow[]).map(toNode),
    edges: (edgeRows as unknown as EdgeRow[]).map(toEdge),
  };
}

/**
 * The full history of a (src, rel_type) relationship ordered by valid_at —
 * including superseded edges — so you can see "how this changed over time"
 * (find_trajectory). Each successive currently-invalid edge was replaced by the
 * next; the final edge with invalid_at = NULL is the current value.
 */
export async function getTrajectory(
  ctx: TenantContext,
  srcId: string,
  relType: string,
): Promise<GraphEdge[]> {
  const db = getKysely();
  const rows = await db
    .selectFrom("kg_edges")
    .select(EDGE_COLUMNS)
    .where("user_id", "=", ctx.userId)
    .where("src_id", "=", srcId)
    .where("rel_type", "=", relType)
    .orderBy("valid_at", "asc")
    .execute();
  return (rows as unknown as EdgeRow[]).map(toEdge);
}

// ---------------------------------------------------------------------------
// Backfill (one-time): promote existing implicit relationships into the graph.
// ---------------------------------------------------------------------------

export interface BackfillResult {
  personNodes: number;
  wikiNodes: number;
  linkEdges: number;
}

/**
 * Promote what Nomos already captures into the graph, idempotently:
 *   - contacts            -> person nodes (external_ref = contacts.id)
 *   - contact_identities  -> aliases folded onto the person node
 *   - wiki_articles       -> wiki nodes (external_ref = path)
 *   - wiki backlinks[]    -> links_to edges between wiki nodes
 *
 * Scoped to one TenantContext. For multi-user (shared-DB) installs call once
 * per user; wiki_articles has no user_id so its rows are stamped with ctx.userId.
 */
export async function backfillGraph(ctx: TenantContext = LOCAL_TENANT): Promise<BackfillResult> {
  const db = getKysely();
  const uid = ctx.userId;

  const persons = await sql<{ n: string }>`
    WITH ins AS (
      INSERT INTO kg_nodes (kind, name, canonical_key, external_kind, external_ref, user_id, confidence)
      SELECT 'person', c.display_name, lower(trim(c.display_name)), 'contact', c.id::text, ${uid}, 0.9
      FROM contacts c
      WHERE c.user_id = ${uid}
      ON CONFLICT (user_id, kind, canonical_key) DO NOTHING
      RETURNING 1
    ) SELECT count(*)::text AS n FROM ins
  `.execute(db);

  // Fold cross-channel identity display names into the person node's aliases.
  await sql`
    UPDATE kg_nodes n SET aliases = ARRAY(
      SELECT DISTINCT a FROM unnest(
        n.aliases || COALESCE((
          SELECT array_agg(ci.display_name)
          FROM contact_identities ci
          WHERE ci.contact_id::text = n.external_ref AND ci.display_name IS NOT NULL
        ), '{}')
      ) a WHERE a IS NOT NULL AND a <> n.name
    )
    WHERE n.external_kind = 'contact' AND n.user_id = ${uid}
  `.execute(db);

  const wikis = await sql<{ n: string }>`
    WITH ins AS (
      INSERT INTO kg_nodes (kind, name, canonical_key, external_kind, external_ref, user_id, confidence)
      SELECT 'wiki', w.title, lower(w.path), 'wiki', w.path, ${uid}, 0.8
      FROM wiki_articles w
      ON CONFLICT (user_id, kind, canonical_key) DO NOTHING
      RETURNING 1
    ) SELECT count(*)::text AS n FROM ins
  `.execute(db);

  // wiki_articles.backlinks[] -> links_to edges between wiki nodes.
  const links = await sql<{ n: string }>`
    WITH ins AS (
      INSERT INTO kg_edges (src_id, dst_id, rel_type, origin, user_id)
      SELECT src.id, dst.id, 'links_to', 'frontmatter', ${uid}
      FROM wiki_articles wa
      CROSS JOIN LATERAL unnest(wa.backlinks) AS bl(target)
      JOIN kg_nodes src ON src.external_kind = 'wiki' AND src.external_ref = wa.path AND src.user_id = ${uid}
      JOIN kg_nodes dst ON dst.external_kind = 'wiki' AND dst.external_ref = bl.target AND dst.user_id = ${uid}
      ON CONFLICT (user_id, src_id, dst_id, rel_type, origin, origin_node) DO NOTHING
      RETURNING 1
    ) SELECT count(*)::text AS n FROM ins
  `.execute(db);

  return {
    personNodes: Number(persons.rows[0]?.n ?? 0),
    wikiNodes: Number(wikis.rows[0]?.n ?? 0),
    linkEdges: Number(links.rows[0]?.n ?? 0),
  };
}
