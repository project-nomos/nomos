/**
 * Goals.
 *
 * A goal is a first-class, user-editable vault note under `goals/` — the source
 * of truth the user edits in the vault UI and the agent writes when the user
 * states a goal in chat (via memory_write to a goals/ path). Because the vault is
 * already promoted into the knowledge graph, goals also show up in the Brain.
 *
 * This thin helper reads/writes goal notes and is what the slippage detector
 * consults to flag goals with no recent activity ("what's slipping"). Keeping
 * goals as vault notes avoids a parallel store and keeps them inside the one
 * durable memory the whole system already reasons over.
 */

import { vaultList, type VaultNote } from "../memory/vault.ts";

export const GOALS_PREFIX = "goals/";

export interface Goal {
  /** The vault path, e.g. "goals/ship-v2.md". */
  path: string;
  /** Human title. */
  title: string;
  /** The goal body (markdown). */
  content: string;
  updatedAt: Date;
}

function toGoal(n: VaultNote): Goal {
  return { path: n.path, title: n.title, content: n.content, updatedAt: n.updatedAt };
}

/**
 * List the owner's goals — vault notes under `goals/`. Goals are authored through
 * the normal vault write path (the agent's memory_write to a goals/ path when the
 * user states a goal; the user edits them in the vault UI), so there is no
 * separate writer here: the vault is the single source of truth.
 */
export async function listGoals(userId: string): Promise<Goal[]> {
  return (await vaultList(userId, GOALS_PREFIX)).map(toGoal);
}
