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

import { sql } from "kysely";
import { z } from "zod";
import { getKysely } from "../db/client.ts";
import type { TenantContext } from "../auth/tenant-context.ts";
import { invalidateEdge } from "./graph.ts";
import { runReasoningFork } from "../sdk/reasoning-fork.ts";
import { createLogger } from "../lib/logger.ts";

const log = createLogger("graph-contradictions");

/** Relations where a new destination typically supersedes the old one. */
export const SINGLE_VALUED_RELS = new Set(["works_at", "located_in", "reports_to"]);

/**
 * STABLE rubric + JSON-shape spec for the contradiction classifier. Byte-identical
 * across calls so the SDK caches it in the system-prompt prefix; the dynamic
 * new-fact + candidate list is sent as `input`.
 */
const CONTRADICTION_INSTRUCTIONS = `You decide which existing facts a newly-learned fact supersedes.

You are given a new fact and a numbered list of existing facts about the same subject and relationship. Decide which existing facts are NO LONGER TRUE because the new fact supersedes them.

Reply with ONLY a JSON object of the form {"superseded":[1,3]} listing the numbers of the superseded facts; reply {"superseded":[]} if none are contradicted.`;

const supersededSchema = z.object({ superseded: z.array(z.number()).default([]) });

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
  const input = `A new fact was just learned:
"${newFact}"

Existing facts about the same subject and relationship:
${list}`;

  let superseded: number[] = [];
  try {
    const { data } = await runReasoningFork({
      instructions: CONTRADICTION_INSTRUCTIONS,
      input,
      schema: supersededSchema,
      label: "graph-contradiction",
      maxTurns: 1,
    });
    if (!data) return { invalidated: 0 };
    superseded = data.superseded;
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

export interface SupersededFact {
  fact: string;
  invalidAt: Date;
}

/**
 * Fetch facts that a NEWER fact has already superseded (edges with `invalid_at`
 * set) touching a given subject, so the wiki compiler can annotate "previously X,
 * now Y" instead of silently dropping the old claim. Matches the subject against
 * either endpoint's node name or the fact text. Owner-scoped. Zero LLM.
 */
export async function getSupersededFacts(
  userId: string,
  subject: string,
  limit = 5,
): Promise<SupersededFact[]> {
  const like = `%${subject.toLowerCase().trim()}%`;
  if (like === "%%") return [];
  try {
    const db = getKysely();
    const res = await sql<{ fact: string | null; invalid_at: Date }>`
      SELECT e.fact, e.invalid_at
      FROM kg_edges e
      JOIN kg_nodes s ON s.id = e.src_id
      JOIN kg_nodes d ON d.id = e.dst_id
      WHERE e.user_id = ${userId}
        AND e.invalid_at IS NOT NULL
        AND e.fact IS NOT NULL
        AND (lower(s.name) LIKE ${like} OR lower(d.name) LIKE ${like} OR lower(e.fact) LIKE ${like})
      ORDER BY e.invalid_at DESC
      LIMIT ${limit}
    `.execute(db);
    return res.rows
      .filter((r): r is { fact: string; invalid_at: Date } => Boolean(r.fact))
      .map((r) => ({ fact: r.fact, invalidAt: r.invalid_at }));
  } catch {
    return [];
  }
}
