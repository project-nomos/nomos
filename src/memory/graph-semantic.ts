/**
 * Semantic edges (Phase 5) — Smart-Connections-style inferred links computed on
 * top of the existing pgvector embeddings. Nodes get an embedding from their
 * name+summary; then top-K cosine neighbors above a threshold are materialized
 * as `semantic_sibling` edges (origin='semantic', weight=score) so the viz and
 * the agent can traverse "related-by-meaning" alongside explicit links.
 *
 * Materialized (not computed per query), reconciled per node (so a re-run
 * replaces a node's semantic edges), and threshold+top-K capped so the graph
 * stays sparse (avoids the hairball failure mode).
 */

import { sql } from "kysely";
import { getKysely } from "../db/client.ts";
import type { TenantContext } from "../auth/tenant-context.ts";
import { reconcileOriginEdges, type UpsertEdgeInput } from "./graph.ts";
import { generateEmbeddings, isEmbeddingAvailable } from "./embeddings.ts";

/** Embed nodes that don't have an embedding yet (from name + summary). */
export async function embedMissingNodes(
  ctx: TenantContext,
  limit = 256,
): Promise<{ embedded: number }> {
  if (!isEmbeddingAvailable()) return { embedded: 0 };
  const db = getKysely();
  const rows = await db
    .selectFrom("kg_nodes")
    .select(["id", "name", "summary"])
    .where("user_id", "=", ctx.userId)
    .where("embedding", "is", null)
    .limit(limit)
    .execute();
  if (rows.length === 0) return { embedded: 0 };

  const texts = rows.map((r) => (r.summary ? `${r.name}: ${r.summary}` : r.name));
  const embeddings = await generateEmbeddings(texts);

  let embedded = 0;
  for (let i = 0; i < rows.length; i++) {
    const e = embeddings[i];
    if (!e) continue;
    const lit = `[${e.join(",")}]`;
    await db
      .updateTable("kg_nodes")
      .set({ embedding: sql`${lit}::vector` })
      .where("id", "=", rows[i]!.id)
      .where("user_id", "=", ctx.userId)
      .execute();
    embedded++;
  }
  return { embedded };
}

export interface SemanticOptions {
  /** Minimum cosine similarity to keep an edge (default 0.85). */
  threshold?: number;
  /** Max semantic neighbors per node (default 5). */
  topK?: number;
}

/**
 * Materialize `semantic_sibling` edges from pgvector cosine nearest-neighbors.
 * Reconciles per source node (origin='semantic'), so re-running refreshes
 * cleanly. Returns the number of edges written.
 */
export async function materializeSemanticEdges(
  ctx: TenantContext,
  opts: SemanticOptions = {},
): Promise<{ edges: number; nodes: number }> {
  const threshold = opts.threshold ?? 0.85;
  const topK = Math.min(opts.topK ?? 5, 20);
  const db = getKysely();

  const nodes = await db
    .selectFrom("kg_nodes")
    .select(["id"])
    .where("user_id", "=", ctx.userId)
    .where("embedding", "is not", null)
    .execute();

  let edges = 0;
  for (const n of nodes) {
    const nn = await sql<{ id: string; sim: number }>`
      SELECT n2.id, 1 - (n1.embedding <=> n2.embedding) AS sim
      FROM kg_nodes n1
      JOIN kg_nodes n2 ON n2.id <> n1.id
      WHERE n1.id = ${n.id}
        AND n2.user_id = ${ctx.userId}
        AND n2.embedding IS NOT NULL
      ORDER BY n1.embedding <=> n2.embedding ASC
      LIMIT ${topK}
    `.execute(db);

    const inputs: UpsertEdgeInput[] = [];
    for (const row of nn.rows) {
      if (row.sim >= threshold) {
        inputs.push({ srcId: n.id, dstId: row.id, relType: "semantic_sibling", weight: row.sim });
      }
    }
    await reconcileOriginEdges(ctx, n.id, "semantic", inputs);
    edges += inputs.length;
  }
  return { edges, nodes: nodes.length };
}
