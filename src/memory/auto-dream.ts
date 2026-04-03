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
