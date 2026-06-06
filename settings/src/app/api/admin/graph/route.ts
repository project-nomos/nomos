import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";

/**
 * Knowledge-graph projection for the /admin/graph visualization.
 *
 * Modes:
 *   - global (default): the most-recently-updated nodes (capped) + the edges
 *     among them.
 *   - local: `?node=<id>&depth=N` returns the depth-bounded ego-network around
 *     a node (the recursive CTE scopes user_id at every hop).
 *
 * Query params:
 *   node           focus node id (enables local mode)
 *   depth          local-graph hops (1-3, default 2)
 *   kinds          comma-separated node-kind filter (global mode)
 *   limit          max nodes (default 600)
 *   user           user_id scope (default 'local')
 *   includeInvalid include superseded edges (time-travel), default false
 */
export async function GET(req: Request) {
  try {
    const sql = getDb();
    const url = new URL(req.url);
    const user = url.searchParams.get("user") || "local";
    const node = url.searchParams.get("node");
    const depth = Math.min(Math.max(Number(url.searchParams.get("depth")) || 2, 1), 3);
    const limit = Math.min(Number(url.searchParams.get("limit")) || 600, 5000);
    const includeInvalid = url.searchParams.get("includeInvalid") === "true";
    const kinds = (url.searchParams.get("kinds") || "")
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean);

    // Resolve the node id set.
    let ids: string[];
    if (node) {
      const reach = await sql<{ id: string }[]>`
        WITH RECURSIVE reach(id, depth) AS (
          SELECT id, 0 FROM kg_nodes WHERE id = ${node} AND user_id = ${user}
          UNION
          SELECT (CASE WHEN e.src_id = r.id THEN e.dst_id ELSE e.src_id END), r.depth + 1
          FROM reach r
          JOIN kg_edges e
            ON (e.src_id = r.id OR e.dst_id = r.id)
           AND e.user_id = ${user}
           ${includeInvalid ? sql`` : sql`AND e.invalid_at IS NULL`}
          WHERE r.depth < ${depth}
        )
        SELECT DISTINCT id FROM reach LIMIT ${limit}
      `;
      ids = reach.map((r) => r.id);
    } else {
      const nodeRows = await sql<{ id: string }[]>`
        SELECT id FROM kg_nodes
        WHERE user_id = ${user}
        ${kinds.length ? sql`AND kind = ANY(${kinds})` : sql``}
        ORDER BY updated_at DESC
        LIMIT ${limit}
      `;
      ids = nodeRows.map((r) => r.id);
    }

    if (ids.length === 0) {
      return NextResponse.json({
        nodes: [],
        links: [],
        kinds: [],
        relTypes: [],
        stats: emptyStats(),
      });
    }

    const nodes = await sql<NodeRow[]>`
      SELECT id, kind, name, aliases, summary, external_kind, external_ref,
             confidence, created_at, updated_at,
             (SELECT count(*) FROM kg_edges e
              WHERE (e.src_id = n.id OR e.dst_id = n.id) AND e.user_id = ${user}
              AND e.invalid_at IS NULL) AS degree
      FROM kg_nodes n
      WHERE id = ANY(${ids}) AND user_id = ${user}
    `;

    const edges = await sql<EdgeRow[]>`
      SELECT id, src_id, dst_id, rel_type, fact, origin, weight, invalid_at
      FROM kg_edges
      WHERE user_id = ${user}
        AND src_id = ANY(${ids}) AND dst_id = ANY(${ids})
        ${includeInvalid ? sql`` : sql`AND invalid_at IS NULL`}
    `;

    // Facets for the UI (whole-graph, not just the projected slice).
    const kindFacets = await sql<{ kind: string; count: string }[]>`
      SELECT kind, count(*)::text AS count FROM kg_nodes WHERE user_id = ${user} GROUP BY kind ORDER BY count(*) DESC
    `;
    const relFacets = await sql<{ rel_type: string; count: string }[]>`
      SELECT rel_type, count(*)::text AS count FROM kg_edges WHERE user_id = ${user} AND invalid_at IS NULL GROUP BY rel_type ORDER BY count(*) DESC
    `;
    const [totals] = await sql<{ nodes: string; edges: string }[]>`
      SELECT
        (SELECT count(*) FROM kg_nodes WHERE user_id = ${user})::text AS nodes,
        (SELECT count(*) FROM kg_edges WHERE user_id = ${user} AND invalid_at IS NULL)::text AS edges
    `;

    return NextResponse.json({
      nodes: nodes.map((n) => ({
        id: n.id,
        kind: n.kind,
        name: n.name,
        aliases: n.aliases ?? [],
        summary: n.summary,
        externalKind: n.external_kind,
        externalRef: n.external_ref,
        confidence: Number(n.confidence),
        degree: Number(n.degree),
      })),
      // Force-graph convention: links use source/target.
      links: edges.map((e) => ({
        id: e.id,
        source: e.src_id,
        target: e.dst_id,
        relType: e.rel_type,
        fact: e.fact,
        origin: e.origin,
        weight: Number(e.weight),
        invalid: e.invalid_at != null,
      })),
      kinds: kindFacets.map((k) => ({ kind: k.kind, count: Number(k.count) })),
      relTypes: relFacets.map((r) => ({ relType: r.rel_type, count: Number(r.count) })),
      stats: {
        totalNodes: Number(totals?.nodes ?? 0),
        totalEdges: Number(totals?.edges ?? 0),
        shownNodes: nodes.length,
        shownEdges: edges.length,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // kg_* tables may not exist yet on an un-migrated DB — return a soft error.
    return NextResponse.json(
      { nodes: [], links: [], kinds: [], relTypes: [], stats: emptyStats(), error: message },
      { status: 200 },
    );
  }
}

function emptyStats() {
  return { totalNodes: 0, totalEdges: 0, shownNodes: 0, shownEdges: 0 };
}

interface NodeRow {
  id: string;
  kind: string;
  name: string;
  aliases: string[] | null;
  summary: string | null;
  external_kind: string | null;
  external_ref: string | null;
  confidence: number;
  created_at: Date;
  updated_at: Date;
  degree: number;
}

interface EdgeRow {
  id: string;
  src_id: string;
  dst_id: string;
  rel_type: string;
  fact: string | null;
  origin: string;
  weight: number;
  invalid_at: Date | null;
}
