/**
 * Brain overview -- the read model behind MobileApi.GetBrain.
 *
 * Composes the consumer Brain page from real per-user memory: the knowledge
 * graph (kg_nodes / kg_edges, via getProjection) for the map + entities, and the
 * accumulated user_model for the "recently learned" facts feed. Owner-scoped via
 * the TenantContext that every query already threads.
 */

import type { TenantContext } from "../auth/tenant-context.ts";
import { getProjection } from "./graph.ts";
import { getUserModel, type UserModelEntry } from "../db/user-model.ts";
import { getKysely } from "../db/client.ts";

export interface BrainNodeView {
  id: string;
  label: string;
  kind: string; // person | org | topic | decision | project | value | event | wiki | vault | ...
  summary: string;
  degree: number;
  confidence: number;
}

export interface BrainEdgeView {
  src: string;
  dst: string;
  relation: string;
}

export interface BrainFactView {
  text: string;
  source: string;
  confidence: number; // 0..3 (binned from the 0..1 model confidence)
  learnedAt: string; // ISO-8601
}

export interface BrainOverview {
  nodes: BrainNodeView[];
  edges: BrainEdgeView[];
  facts: BrainFactView[];
  entityCount: number;
  factCount: number;
}

function factText(e: UserModelEntry): string {
  const v = e.value;
  if (typeof v === "string") return v;
  if (v == null) return e.key;
  if (typeof v === "object") return `${e.key}: ${JSON.stringify(v)}`;
  return `${e.key}: ${String(v)}`;
}

export async function getBrainOverview(
  ctx: TenantContext,
  opts: { nodeLimit?: number; factLimit?: number } = {},
): Promise<BrainOverview> {
  const nodeLimit = opts.nodeLimit ?? 48;
  const factLimit = opts.factLimit ?? 12;

  // Map: the most-recent slice of the graph + the edges within it.
  const sub = await getProjection(ctx, { limit: nodeLimit });

  const degree = new Map<string, number>();
  for (const e of sub.edges) {
    degree.set(e.srcId, (degree.get(e.srcId) ?? 0) + 1);
    degree.set(e.dstId, (degree.get(e.dstId) ?? 0) + 1);
  }

  const nodes: BrainNodeView[] = sub.nodes.map((n) => ({
    id: n.id,
    label: n.name,
    kind: n.kind,
    summary: n.summary ?? "",
    degree: degree.get(n.id) ?? 0,
    confidence: n.confidence,
  }));

  const edges: BrainEdgeView[] = sub.edges.map((e) => ({
    src: e.srcId,
    dst: e.dstId,
    relation: e.relType.replace(/_/g, " "),
  }));

  // Facts: the accumulated user model (already ordered confidence desc, recent).
  const model = await getUserModel(ctx.userId);
  const facts: BrainFactView[] = model.slice(0, factLimit).map((e) => ({
    text: factText(e),
    source: e.category,
    confidence: Math.max(0, Math.min(3, Math.round((e.confidence ?? 0.5) * 3))),
    learnedAt: e.updatedAt ? new Date(e.updatedAt).toISOString() : "",
  }));

  const db = getKysely();
  const counted = await db
    .selectFrom("kg_nodes")
    .select((eb) => eb.fn.countAll<string>().as("c"))
    .where("user_id", "=", ctx.userId)
    .executeTakeFirst();

  return {
    nodes,
    edges,
    facts,
    entityCount: Number(counted?.c ?? nodes.length),
    factCount: model.length,
  };
}
