/**
 * Auto-Dream — background memory consolidation.
 *
 * Automatically consolidates session transcripts into persistent memory
 * on a schedule or after a threshold of new turns. Uses time-gating
 * and turn-counting to avoid excessive consolidation, and a lock file
 * to prevent parallel runs.
 *
 * Adapted from Claude Code's autoDream service.
 *
 * Phases:
 * 1. Orient — scan recent transcripts, identify what's new
 * 2. Gather — collect key facts, decisions, corrections
 * 3. Consolidate — merge into existing memory chunks
 * 4. Prune — remove stale/duplicate chunks
 */

import { createLogger } from "../lib/logger.ts";
import { getKysely } from "../db/client.ts";
import { withLease } from "../storage/leases.ts";
import { isRedisConfigured } from "../storage/redis.ts";

const log = createLogger("auto-dream");

/** Minimum time between consolidation runs (1 hour). */
const MIN_INTERVAL_MS = 60 * 60 * 1000;

/** Minimum new turns before triggering consolidation. */
const MIN_NEW_TURNS = 10;

/** Lease name for distributed mutex. */
const LEASE_NAME = "auto-dream";

/** Lease TTL — long enough to cover a normal consolidation run. */
const LEASE_TTL_SEC = 30 * 60;

interface ConsolidationState {
  lastRunAt: string;
  lastTurnCount: number;
  totalRuns: number;
  /** The last run's outcome (merged/pruned/etc.), persisted to state_json. */
  lastResult?: Record<string, unknown>;
}

interface DreamResult {
  merged: number;
  pruned: number;
  newChunks: number;
  durationMs: number;
}

/**
 * Load the consolidation state from the database.
 */
async function loadState(): Promise<ConsolidationState> {
  try {
    const db = getKysely();
    const row = await db
      .selectFrom("auto_dream_state")
      .selectAll()
      .where("id", "=", 1)
      .executeTakeFirst();
    if (!row) {
      return { lastRunAt: "", lastTurnCount: 0, totalRuns: 0 };
    }
    return {
      lastRunAt: row.last_run_at ? new Date(row.last_run_at).toISOString() : "",
      lastTurnCount: row.last_turn_count,
      totalRuns: row.total_runs,
      lastResult: (row.state_json as Record<string, unknown> | null) ?? undefined,
    };
  } catch (err) {
    log.warn({ err }, "Failed to load auto-dream state");
    return { lastRunAt: "", lastTurnCount: 0, totalRuns: 0 };
  }
}

/**
 * Save the consolidation state to the database.
 */
async function saveState(state: ConsolidationState): Promise<void> {
  const db = getKysely();
  await db
    .insertInto("auto_dream_state")
    .values({
      id: 1,
      last_run_at: state.lastRunAt ? new Date(state.lastRunAt) : null,
      last_turn_count: state.lastTurnCount,
      total_runs: state.totalRuns,
      // Pass the OBJECT (not JSON.stringify): postgres-js serializes to jsonb
      // once. Stringifying first double-encodes into a jsonb *string*.
      state_json: (state.lastResult ?? null) as unknown as string | null,
    })
    .onConflict((oc) =>
      oc.column("id").doUpdateSet({
        last_run_at: state.lastRunAt ? new Date(state.lastRunAt) : null,
        last_turn_count: state.lastTurnCount,
        total_runs: state.totalRuns,
        state_json: (state.lastResult ?? null) as unknown as string | null,
        updated_at: new Date(),
      }),
    )
    .execute();
}

/**
 * Check if consolidation should run based on time and turn count.
 */
export async function shouldConsolidate(currentTurnCount: number): Promise<boolean> {
  const state = await loadState();

  // Check time gate
  if (state.lastRunAt) {
    const elapsed = Date.now() - new Date(state.lastRunAt).getTime();
    if (elapsed < MIN_INTERVAL_MS) {
      return false;
    }
  }

  // Check turn count gate
  const newTurns = currentTurnCount - state.lastTurnCount;
  return newTurns >= MIN_NEW_TURNS;
}

/**
 * The consolidation prompt used to extract key information from transcripts.
 *
 * Runs in 4 phases:
 * 1. Orient — understand what sessions exist and what's been discussed
 * 2. Gather — extract facts, decisions, corrections, preferences
 * 3. Consolidate — merge with existing memory, deduplicate
 * 4. Prune — remove stale entries
 */
export const CONSOLIDATION_PROMPT = `You are a memory consolidation agent. Your job is to review recent conversation transcripts and extract the most important information into persistent memory.

## Process

### Phase 1: Orient
Scan all recent transcripts. Identify:
- What projects/tasks were discussed
- What the user's goals were
- What was accomplished vs. what remains

### Phase 2: Gather
Extract key information in these categories:
- **Facts**: Technical details, architecture decisions, file paths, configurations
- **Corrections**: User feedback on what was wrong, what to avoid
- **Preferences**: How the user likes to work, communication style, tools they prefer
- **Decisions**: Important choices made and their rationale

### Phase 3: Consolidate
For each extracted item:
- Check if it already exists in memory (skip duplicates)
- If it updates existing knowledge, merge/replace the old entry
- If it contradicts existing knowledge, keep the newer version
- Assign a category: fact, correction, preference, decision, skill

### Phase 4: Prune
Review existing memory for:
- Duplicate entries (merge them)
- Stale entries (mark for review if >30 days old and not recently accessed)
- Entries that have been superseded by newer information

### Phase 5: Reflect (Value Re-evaluation)
Review the user's decision patterns and values in light of recent conversations:
- Are any decision patterns contradicted by recent behavior? (decrease their weight)
- Are any values reinforced by new evidence? (increase their confidence)
- Did the user reveal new values or heuristics not yet captured?
- Are any patterns too narrow or too broad? Suggest refinements.

For value re-ranking, output:
- values_to_boost: [{key, reason}] -- values reinforced by recent evidence
- values_to_decrease: [{key, reason}] -- values contradicted by recent behavior
- new_values: [{value, description, context, evidence}] -- newly discovered values
- pattern_refinements: [{key, refinement}] -- decision patterns that need updating

Output a structured JSON result with your findings.`;

/**
 * Run the auto-dream consolidation process.
 *
 * This is a fire-and-forget background task. It:
 * 1. Checks if consolidation should run
 * 2. Acquires a lock
 * 3. Runs the consolidation (via LLM call to analyze transcripts)
 * 4. Updates memory chunks in the database
 * 5. Releases the lock and updates state
 *
 * @param currentTurnCount - The current total number of conversation turns
 * @param runConsolidation - Function that executes the actual LLM-based consolidation
 */
export async function autoDream(
  currentTurnCount: number,
  runConsolidation: () => Promise<DreamResult>,
): Promise<DreamResult | null> {
  // Check if we should run
  const shouldRun = await shouldConsolidate(currentTurnCount);
  if (!shouldRun) return null;

  if (!isRedisConfigured()) {
    log.debug("Redis not configured; running consolidation without distributed lease");
  }

  const result = await withLease(
    LEASE_NAME,
    async () => {
      log.info("Starting background consolidation...");
      const start = Date.now();

      try {
        const r = await runConsolidation();
        r.durationMs = Date.now() - start;

        // Update state, persisting the run outcome to state_json.
        const state = await loadState();
        state.lastRunAt = new Date().toISOString();
        state.lastTurnCount = currentTurnCount;
        state.totalRuns += 1;
        state.lastResult = { ...r };
        await saveState(state);

        log.info(
          {
            newChunks: r.newChunks,
            merged: r.merged,
            pruned: r.pruned,
            durationMs: r.durationMs,
          },
          "Consolidation complete",
        );
        return r;
      } catch (err) {
        log.error({ err }, "Consolidation failed");
        return null;
      }
    },
    { ttlSec: LEASE_TTL_SEC },
  );

  if (result === null) {
    log.info("Another consolidation is in progress, skipping");
  }
  return result;
}

/**
 * Get the consolidation state for display.
 */
export async function getConsolidationState(): Promise<ConsolidationState> {
  return loadState();
}

/**
 * Instance-wide activity counter used as the auto-dream turn gate.
 *
 * Total persisted memory chunks is a cheap monotonic proxy for "how much has
 * happened since the last consolidation" across all owners on this instance.
 */
async function instanceActivityCount(): Promise<number> {
  try {
    const db = getKysely();
    const row = await db
      .selectFrom("memory_chunks")
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .executeTakeFirst();
    return Number(row?.count ?? 0);
  } catch (err) {
    log.warn({ err }, "Failed to count memory chunks for auto-dream gate");
    return 0;
  }
}

/**
 * Run one autonomous auto-dream cycle.
 *
 * This is the production entry point (invoked by the daemon's cron sentinel).
 * The singleton gate (time + turn) and distributed lease live in `autoDream`;
 * the consolidation work fans out per memory owner so every tenant on the
 * instance gets consolidated, and the aggregate result is persisted to
 * `auto_dream_state.state_json`.
 */
export async function runAutoDreamCycle(): Promise<DreamResult | null> {
  const turnCount = await instanceActivityCount();
  return autoDream(turnCount, async () => {
    const { listMemoryOwners } = await import("../auth/org-members.ts");
    const { consolidateMemory, reflectOnValues } = await import("./consolidator.ts");
    const owners = await listMemoryOwners();
    const agg: DreamResult = { merged: 0, pruned: 0, newChunks: 0, durationMs: 0 };
    for (const userId of owners) {
      try {
        const r = await consolidateMemory(userId);
        agg.merged += r.merged;
        agg.pruned += r.pruned;
        // "newChunks" tracks chunks rewritten/regenerated during consolidation.
        agg.newChunks += r.rewritten;
        // Phase 5: re-rank the owner's values from a reflection pass (best-effort;
        // never let it break consolidation). Skips owners with no values/patterns.
        try {
          const reflection = await reflectOnValues(userId);
          if (reflection) await reRankValues(userId, reflection);
        } catch (err) {
          log.warn({ err, userId }, "Value re-ranking failed");
        }
      } catch (err) {
        log.warn({ err, userId }, "Per-owner consolidation failed");
      }
    }
    return agg;
  });
}

/**
 * Post-consolidation value re-ranking.
 *
 * Adjusts confidence scores on values and weights on decision patterns
 * based on the reflection phase output from consolidation.
 */
export async function reRankValues(
  userId: string,
  reflection: {
    values_to_boost?: { key: string; reason: string }[];
    values_to_decrease?: { key: string; reason: string }[];
    new_values?: { value: string; description: string; context: string; evidence: string[] }[];
    pattern_refinements?: { key: string; refinement: string }[];
  },
): Promise<{ boosted: number; decreased: number; added: number; refined: number }> {
  const { getUserModel, upsertUserModel } = await import("../db/user-model.ts");
  const result = { boosted: 0, decreased: 0, added: 0, refined: 0 };

  // Boost values reinforced by evidence
  if (reflection.values_to_boost) {
    const values = await getUserModel(userId, "value");
    for (const boost of reflection.values_to_boost) {
      const entry = values.find((e) => e.key === boost.key);
      if (entry) {
        const newConfidence = Math.min((entry.confidence + 0.1) * 1.05, 0.95);
        await upsertUserModel({
          userId: userId,
          category: "value",
          key: entry.key,
          value: entry.value,
          sourceIds: entry.sourceIds,
          confidence: Math.round(newConfidence * 100) / 100,
        });
        result.boosted++;
      }
    }
  }

  // Decrease values contradicted by behavior
  if (reflection.values_to_decrease) {
    const values = await getUserModel(userId, "value");
    for (const dec of reflection.values_to_decrease) {
      const entry = values.find((e) => e.key === dec.key);
      if (entry) {
        const newConfidence = Math.max(entry.confidence * 0.85 - 0.05, 0.1);
        await upsertUserModel({
          userId: userId,
          category: "value",
          key: entry.key,
          value: entry.value,
          sourceIds: entry.sourceIds,
          confidence: Math.round(newConfidence * 100) / 100,
        });
        result.decreased++;
      }
    }
  }

  // Add newly discovered values
  if (reflection.new_values) {
    for (const nv of reflection.new_values) {
      const key = nv.value
        .slice(0, 60)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_|_$/g, "");

      await upsertUserModel({
        userId: userId,
        category: "value",
        key,
        value: {
          value: nv.value,
          description: nv.description,
          context: nv.context,
          evidence: nv.evidence,
        },
        sourceIds: [],
        confidence: 0.6, // Moderate confidence -- inferred from behavior, not explicit
      });
      result.added++;
    }
  }

  // Refine decision patterns
  if (reflection.pattern_refinements) {
    const patterns = await getUserModel(userId, "decision_pattern");
    for (const ref of reflection.pattern_refinements) {
      const entry = patterns.find((e) => e.key === ref.key);
      if (entry) {
        const val = entry.value as Record<string, unknown>;
        const evidence = (val.evidence as string[]) ?? [];
        await upsertUserModel({
          userId: userId,
          category: "decision_pattern",
          key: entry.key,
          value: {
            ...val,
            principle: ref.refinement,
            evidence: [...evidence, `Refined during auto-dream consolidation`].slice(0, 10),
          },
          sourceIds: entry.sourceIds,
          confidence: entry.confidence,
        });
        result.refined++;
      }
    }
  }

  if (result.boosted + result.decreased + result.added + result.refined > 0) {
    log.info(
      {
        boosted: result.boosted,
        decreased: result.decreased,
        added: result.added,
        refined: result.refined,
      },
      "Value re-ranking",
    );
  }

  return result;
}
