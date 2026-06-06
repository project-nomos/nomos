/**
 * Scoped contradiction handling (Phase 4) — Graphiti/Zep "invalidate, never
 * delete". When a single-valued fact-edge gets a new value, we find the
 * currently-valid edges with the SAME (src, rel_type) but a DIFFERENT
 * destination, ask ONE Haiku call whether the new fact supersedes them, and set
 * `invalid_at` on the confirmed ones (history preserved, queryable via
 * getTrajectory / neighborhood({asOf})).
 *
 * Cost-bounded: only same-pair candidates, one LLM call, off the hot path.
 */

import { getKysely } from "../db/client.ts";
import type { TenantContext } from "../auth/tenant-context.ts";
import { invalidateEdge } from "./graph.ts";
import { runForkedAgent } from "../sdk/forked-agent.ts";
import { createLogger } from "../lib/logger.ts";

const log = createLogger("graph-contradictions");

/** Relations where a new destination typically supersedes the old one. */
export const SINGLE_VALUED_RELS = new Set(["works_at", "located_in", "reports_to"]);

export interface ContradictionInput {
  srcId: string;
  relType: string;
  dstId: string;
  fact: string | null;
  validAt: Date;
}

/**
 * Check + apply contradictions for a newly-asserted edge. Returns how many
 * existing edges were invalidated. No-op (0) for multi-valued relations, when
 * there are no same-pair candidates, or if the classifier is unavailable.
 */
export async function checkContradictions(
  ctx: TenantContext,
  edge: ContradictionInput,
): Promise<{ invalidated: number }> {
  if (!SINGLE_VALUED_RELS.has(edge.relType)) return { invalidated: 0 };
  const db = getKysely();

  const candidates = await db
    .selectFrom("kg_edges as e")
    .innerJoin("kg_nodes as n", "n.id", "e.dst_id")
    .select(["e.id as id", "e.fact as fact", "n.name as dstName"])
    .where("e.user_id", "=", ctx.userId)
    .where("e.src_id", "=", edge.srcId)
    .where("e.rel_type", "=", edge.relType)
    .where("e.dst_id", "!=", edge.dstId)
    .where("e.invalid_at", "is", null)
    .execute();

  if (candidates.length === 0) return { invalidated: 0 };

  const newFact = edge.fact ?? `new ${edge.relType.replace(/_/g, " ")} value`;
  const list = candidates.map((c, i) => `${i + 1}. ${c.fact ?? c.dstName}`).join("\n");
  const prompt = `A new fact was just learned:
"${newFact}"

Existing facts about the same subject and relationship:
${list}

Which existing facts are NO LONGER TRUE because the new fact supersedes them? Reply with ONLY a JSON array of their numbers (e.g. [1,3]); reply [] if none are contradicted.`;

  let superseded: number[] = [];
  try {
    const res = await runForkedAgent({ prompt, label: "graph-contradiction", maxTurns: 1 });
    const match = res.text.match(/\[[\d,\s]*\]/);
    if (match) {
      const parsed: unknown = JSON.parse(match[0]);
      if (Array.isArray(parsed))
        superseded = parsed.filter((n): n is number => typeof n === "number");
    }
  } catch (err) {
    log.debug({ err }, "Contradiction classifier failed; leaving edges intact");
    return { invalidated: 0 };
  }

  let invalidated = 0;
  for (const idx of superseded) {
    const cand = candidates[idx - 1];
    if (!cand) continue;
    await invalidateEdge(ctx, cand.id, edge.validAt);
    invalidated++;
  }
  if (invalidated > 0) {
    log.info({ invalidated, rel: edge.relType }, "Superseded contradicting edges");
  }
  return { invalidated };
}
