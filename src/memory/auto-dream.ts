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

import { readFile, writeFile, unlink, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

/** Minimum time between consolidation runs (1 hour). */
const MIN_INTERVAL_MS = 60 * 60 * 1000;

/** Minimum new turns before triggering consolidation. */
const MIN_NEW_TURNS = 10;

/** Lock file to prevent parallel consolidation. */
const LOCK_FILE = "consolidation.lock";

/** State file tracking last consolidation. */
const STATE_FILE = "consolidation-state.json";

interface ConsolidationState {
  lastRunAt: string;
  lastTurnCount: number;
  totalRuns: number;
}

interface DreamResult {
  merged: number;
  pruned: number;
  newChunks: number;
  durationMs: number;
}

/**
 * Get the directory for auto-dream state files.
 */
function getDreamDir(): string {
  return join(homedir(), ".nomos", "auto-dream");
}

/**
 * Load the consolidation state.
 */
async function loadState(): Promise<ConsolidationState> {
  const statePath = join(getDreamDir(), STATE_FILE);
  try {
    const content = await readFile(statePath, "utf-8");
    return JSON.parse(content) as ConsolidationState;
  } catch {
    return { lastRunAt: "", lastTurnCount: 0, totalRuns: 0 };
  }
}

/**
 * Save the consolidation state.
 */
async function saveState(state: ConsolidationState): Promise<void> {
  const dir = getDreamDir();
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, STATE_FILE), JSON.stringify(state, null, 2), "utf-8");
}

/**
 * Acquire a lock for consolidation.
 * Returns true if the lock was acquired, false if another process holds it.
 */
async function acquireLock(): Promise<boolean> {
  const lockPath = join(getDreamDir(), LOCK_FILE);
  try {
    // Check if lock exists and is not stale (older than 30 minutes)
    const content = await readFile(lockPath, "utf-8");
    const lockData = JSON.parse(content) as { pid: number; acquiredAt: string };
    const lockAge = Date.now() - new Date(lockData.acquiredAt).getTime();

    if (lockAge < 30 * 60 * 1000) {
      // Lock is still fresh — another process is consolidating
      return false;
    }
    // Lock is stale — remove it and proceed
  } catch {
    // No lock file — proceed
  }

  // Create lock file
  const dir = getDreamDir();
  await mkdir(dir, { recursive: true });
  await writeFile(
    lockPath,
    JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }),
    "utf-8",
  );
  return true;
}

/**
 * Release the consolidation lock.
 */
async function releaseLock(): Promise<void> {
  const lockPath = join(getDreamDir(), LOCK_FILE);
  try {
    await unlink(lockPath);
  } catch {
    // Lock already released or doesn't exist
  }
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

  // Acquire lock
  const locked = await acquireLock();
  if (!locked) {
    console.log("[auto-dream] Another consolidation is in progress, skipping");
    return null;
  }

  try {
    console.log("[auto-dream] Starting background consolidation...");
    const start = Date.now();

    const result = await runConsolidation();
    result.durationMs = Date.now() - start;

    // Update state
    const state = await loadState();
    state.lastRunAt = new Date().toISOString();
    state.lastTurnCount = currentTurnCount;
    state.totalRuns += 1;
    await saveState(state);

    console.log(
      `[auto-dream] Consolidation complete: ${result.newChunks} new, ${result.merged} merged, ${result.pruned} pruned (${result.durationMs}ms)`,
    );

    return result;
  } catch (err) {
    console.error("[auto-dream] Consolidation failed:", err);
    return null;
  } finally {
    await releaseLock();
  }
}

/**
 * Get the consolidation state for display.
 */
export async function getConsolidationState(): Promise<ConsolidationState> {
  return loadState();
}

/**
 * Post-consolidation value re-ranking.
 *
 * Adjusts confidence scores on values and weights on decision patterns
 * based on the reflection phase output from consolidation.
 */
export async function reRankValues(reflection: {
  values_to_boost?: { key: string; reason: string }[];
  values_to_decrease?: { key: string; reason: string }[];
  new_values?: { value: string; description: string; context: string; evidence: string[] }[];
  pattern_refinements?: { key: string; refinement: string }[];
}): Promise<{ boosted: number; decreased: number; added: number; refined: number }> {
  const { getUserModel, upsertUserModel } = await import("../db/user-model.ts");
  const result = { boosted: 0, decreased: 0, added: 0, refined: 0 };

  // Boost values reinforced by evidence
  if (reflection.values_to_boost) {
    const values = await getUserModel("value");
    for (const boost of reflection.values_to_boost) {
      const entry = values.find((e) => e.key === boost.key);
      if (entry) {
        const newConfidence = Math.min((entry.confidence + 0.1) * 1.05, 0.95);
        await upsertUserModel({
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
    const values = await getUserModel("value");
    for (const dec of reflection.values_to_decrease) {
      const entry = values.find((e) => e.key === dec.key);
      if (entry) {
        const newConfidence = Math.max(entry.confidence * 0.85 - 0.05, 0.1);
        await upsertUserModel({
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
    const patterns = await getUserModel("decision_pattern");
    for (const ref of reflection.pattern_refinements) {
      const entry = patterns.find((e) => e.key === ref.key);
      if (entry) {
        const val = entry.value as Record<string, unknown>;
        const evidence = (val.evidence as string[]) ?? [];
        await upsertUserModel({
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
    console.log(
      `[auto-dream] Value re-ranking: ${result.boosted} boosted, ${result.decreased} decreased, ${result.added} new, ${result.refined} refined`,
    );
  }

  return result;
}
