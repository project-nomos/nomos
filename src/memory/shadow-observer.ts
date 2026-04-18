/**
 * Shadow Mode -- passive behavioral observation.
 *
 * Observes user behavior patterns without requiring explicit interaction:
 * - Tool usage sequences (what tools the user triggers and in what order)
 * - Correction patterns (when the user rejects/modifies agent output)
 * - File access patterns (which files are read/edited frequently)
 * - Response timing (how quickly the user responds, turn cadence)
 *
 * Observations accumulate in memory and are periodically distilled
 * into behavioral patterns via a lightweight LLM call (Haiku).
 * These patterns are stored in user_model as category "behavior".
 *
 * Privacy-first: opt-in via NOMOS_SHADOW_MODE config flag.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";

// ── Types ──

export interface ToolObservation {
  toolName: string;
  /** Brief summary of what the tool did (first 200 chars of input/output). */
  summary: string;
  timestamp: number;
  sessionKey: string;
}

export interface CorrectionObservation {
  /** What the agent produced. */
  original: string;
  /** What the user asked for instead. */
  correction: string;
  context: string;
  timestamp: number;
}

export interface FileAccessObservation {
  filePath: string;
  action: "read" | "edit" | "write";
  timestamp: number;
}

export interface SessionObservations {
  tools: ToolObservation[];
  corrections: CorrectionObservation[];
  fileAccesses: FileAccessObservation[];
  turnTimestamps: number[];
}

export interface BehaviorPattern {
  pattern: string;
  category: string;
  evidence: string[];
  confidence: number;
}

export interface DistillationResult {
  patterns: BehaviorPattern[];
  observationCount: number;
  durationMs: number;
}

// ── Constants ──

/** Minimum observations before triggering distillation. */
const MIN_OBSERVATIONS = 20;

/** Maximum observations to keep in buffer before forced flush. */
const MAX_BUFFER_SIZE = 200;

/** State directory for shadow observations. */
function getShadowDir(): string {
  return join(homedir(), ".nomos", "shadow-mode");
}

const STATE_FILE = "observations.json";

// ── Observer ──

export class ShadowObserver {
  private observations: SessionObservations = {
    tools: [],
    corrections: [],
    fileAccesses: [],
    turnTimestamps: [],
  };

  private enabled: boolean;

  constructor(enabled = false) {
    this.enabled = enabled;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Record a tool usage observation.
   */
  recordToolUse(toolName: string, summary: string, sessionKey: string): void {
    if (!this.enabled) return;

    this.observations.tools.push({
      toolName,
      summary: summary.slice(0, 200),
      timestamp: Date.now(),
      sessionKey,
    });

    this.trimBuffer();
  }

  /**
   * Record a correction (user rejecting or modifying agent output).
   */
  recordCorrection(original: string, correction: string, context: string): void {
    if (!this.enabled) return;

    this.observations.corrections.push({
      original: original.slice(0, 300),
      correction: correction.slice(0, 300),
      context: context.slice(0, 200),
      timestamp: Date.now(),
    });
  }

  /**
   * Record a file access.
   */
  recordFileAccess(filePath: string, action: "read" | "edit" | "write"): void {
    if (!this.enabled) return;

    this.observations.fileAccesses.push({
      filePath,
      action,
      timestamp: Date.now(),
    });

    this.trimBuffer();
  }

  /**
   * Record a user turn timestamp (for response cadence tracking).
   */
  recordTurn(): void {
    if (!this.enabled) return;
    this.observations.turnTimestamps.push(Date.now());
  }

  /**
   * Check if enough observations have accumulated for distillation.
   */
  shouldDistill(): boolean {
    const total =
      this.observations.tools.length +
      this.observations.corrections.length +
      this.observations.fileAccesses.length;
    return total >= MIN_OBSERVATIONS;
  }

  /**
   * Get the accumulated observations for distillation.
   * Does NOT clear the buffer -- call `clearObservations()` after successful distillation.
   */
  getObservations(): SessionObservations {
    return { ...this.observations };
  }

  /**
   * Clear observations after successful distillation.
   */
  clearObservations(): void {
    this.observations = {
      tools: [],
      corrections: [],
      fileAccesses: [],
      turnTimestamps: [],
    };
  }

  /**
   * Get observation counts for status display.
   */
  getStats(): { tools: number; corrections: number; files: number; turns: number } {
    return {
      tools: this.observations.tools.length,
      corrections: this.observations.corrections.length,
      files: this.observations.fileAccesses.length,
      turns: this.observations.turnTimestamps.length,
    };
  }

  /**
   * Persist observations to disk (called on session end or periodically).
   */
  async save(): Promise<void> {
    if (!this.enabled) return;

    const dir = getShadowDir();
    await mkdir(dir, { recursive: true });

    // Merge with any existing observations on disk
    const existing = await loadStoredObservations();
    const merged: SessionObservations = {
      tools: [...existing.tools, ...this.observations.tools],
      corrections: [...existing.corrections, ...this.observations.corrections],
      fileAccesses: [...existing.fileAccesses, ...this.observations.fileAccesses],
      turnTimestamps: [...existing.turnTimestamps, ...this.observations.turnTimestamps],
    };

    await writeFile(join(dir, STATE_FILE), JSON.stringify(merged, null, 2), "utf-8");
  }

  /**
   * Load stored observations from disk (for cross-session continuity).
   */
  async loadFromDisk(): Promise<void> {
    if (!this.enabled) return;

    const stored = await loadStoredObservations();
    this.observations = stored;
  }

  private trimBuffer(): void {
    if (this.observations.tools.length > MAX_BUFFER_SIZE) {
      this.observations.tools = this.observations.tools.slice(-MAX_BUFFER_SIZE);
    }
    if (this.observations.fileAccesses.length > MAX_BUFFER_SIZE) {
      this.observations.fileAccesses = this.observations.fileAccesses.slice(-MAX_BUFFER_SIZE);
    }
  }
}

async function loadStoredObservations(): Promise<SessionObservations> {
  try {
    const content = await readFile(join(getShadowDir(), STATE_FILE), "utf-8");
    return JSON.parse(content) as SessionObservations;
  } catch {
    return { tools: [], corrections: [], fileAccesses: [], turnTimestamps: [] };
  }
}

// ── Distillation Prompt ──

/**
 * Build a prompt for the Haiku agent to distill observations into behavioral patterns.
 */
export function buildDistillationPrompt(observations: SessionObservations): string {
  const parts: string[] = [
    "Analyze the following user behavior observations and extract repeating patterns.",
    "",
    "## Tool Usage Sequences",
  ];

  if (observations.tools.length > 0) {
    // Group tools by session and show sequences
    const bySession = new Map<string, ToolObservation[]>();
    for (const t of observations.tools) {
      const list = bySession.get(t.sessionKey) ?? [];
      list.push(t);
      bySession.set(t.sessionKey, list);
    }
    for (const [session, tools] of bySession) {
      const seq = tools.map((t) => t.toolName).join(" -> ");
      parts.push(`Session ${session.slice(0, 20)}: ${seq}`);
    }
  } else {
    parts.push("No tool observations.");
  }

  parts.push("", "## Corrections");
  if (observations.corrections.length > 0) {
    for (const c of observations.corrections.slice(-10)) {
      parts.push(`- Context: ${c.context}`);
      parts.push(`  Original: ${c.original}`);
      parts.push(`  Correction: ${c.correction}`);
    }
  } else {
    parts.push("No corrections observed.");
  }

  parts.push("", "## File Access Patterns");
  if (observations.fileAccesses.length > 0) {
    // Count file accesses
    const counts = new Map<string, number>();
    for (const f of observations.fileAccesses) {
      const key = `${f.action}:${f.filePath}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    for (const [key, count] of sorted.slice(0, 20)) {
      parts.push(`- ${key} (${count}x)`);
    }
  } else {
    parts.push("No file access observations.");
  }

  parts.push("", "## Response Cadence");
  if (observations.turnTimestamps.length >= 2) {
    const gaps: number[] = [];
    for (let i = 1; i < observations.turnTimestamps.length; i++) {
      gaps.push(observations.turnTimestamps[i]! - observations.turnTimestamps[i - 1]!);
    }
    const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    const minGap = Math.min(...gaps);
    const maxGap = Math.max(...gaps);
    parts.push(
      `Average time between turns: ${(avgGap / 1000).toFixed(1)}s (min: ${(minGap / 1000).toFixed(1)}s, max: ${(maxGap / 1000).toFixed(1)}s)`,
    );
  } else {
    parts.push("Insufficient data.");
  }

  parts.push(
    "",
    "## Instructions",
    "Extract 3-5 behavioral patterns from the observations above.",
    "For each pattern, output JSON:",
    "```json",
    '[{"pattern": "description", "category": "tool_workflow|correction_tendency|file_preference|work_rhythm", "evidence": ["observation1", "observation2"], "confidence": 0.6}]',
    "```",
    "Focus on repeating behaviors, not one-off actions. Only report patterns with at least 2 supporting observations.",
  );

  return parts.join("\n");
}

// ── Singleton ──

let activeObserver: ShadowObserver | null = null;

export function getShadowObserver(enabled?: boolean): ShadowObserver {
  if (!activeObserver) {
    activeObserver = new ShadowObserver(enabled ?? false);
  }
  return activeObserver;
}

export function resetShadowObserver(): void {
  activeObserver = null;
}
