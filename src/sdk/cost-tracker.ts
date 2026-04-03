/**
 * Session cost tracking.
 *
 * Tracks per-session and per-model token usage and USD costs.
 * Adapted from Claude Code's cost-tracker.ts — simplified to use
 * in-memory state with DB persistence via the sessions table.
 *
 * Pricing data from https://docs.anthropic.com/en/docs/about-claude/pricing
 */

import { formatTokenCount } from "./token-estimation.ts";

// ── Pricing Tiers ──

export interface ModelCosts {
  inputTokens: number; // per 1M tokens
  outputTokens: number; // per 1M tokens
  cacheWriteTokens: number; // per 1M tokens
  cacheReadTokens: number; // per 1M tokens
  webSearchRequests: number; // per request
}

// Sonnet tier: $3/$15 per Mtok
const COST_SONNET: ModelCosts = {
  inputTokens: 3,
  outputTokens: 15,
  cacheWriteTokens: 3.75,
  cacheReadTokens: 0.3,
  webSearchRequests: 0.01,
};

// Opus 4/4.1 tier: $15/$75 per Mtok
const COST_OPUS_LEGACY: ModelCosts = {
  inputTokens: 15,
  outputTokens: 75,
  cacheWriteTokens: 18.75,
  cacheReadTokens: 1.5,
  webSearchRequests: 0.01,
};

// Opus 4.5/4.6 tier: $5/$25 per Mtok
const COST_OPUS: ModelCosts = {
  inputTokens: 5,
  outputTokens: 25,
  cacheWriteTokens: 6.25,
  cacheReadTokens: 0.5,
  webSearchRequests: 0.01,
};

// Haiku 3.5: $0.80/$4 per Mtok
const COST_HAIKU_35: ModelCosts = {
  inputTokens: 0.8,
  outputTokens: 4,
  cacheWriteTokens: 1,
  cacheReadTokens: 0.08,
  webSearchRequests: 0.01,
};

// Haiku 4.5: $1/$5 per Mtok
const COST_HAIKU_45: ModelCosts = {
  inputTokens: 1,
  outputTokens: 5,
  cacheWriteTokens: 1.25,
  cacheReadTokens: 0.1,
  webSearchRequests: 0.01,
};

/** Default costs for unknown models. */
const DEFAULT_COSTS = COST_OPUS;

/**
 * Model name → pricing tier lookup.
 * Matches against canonical short names extracted from full model IDs.
 */
const MODEL_PRICING: Record<string, ModelCosts> = {
  // Haiku
  "claude-3-5-haiku": COST_HAIKU_35,
  "claude-haiku-4-5": COST_HAIKU_45,
  // Sonnet
  "claude-3-5-sonnet": COST_SONNET,
  "claude-3-7-sonnet": COST_SONNET,
  "claude-sonnet-4": COST_SONNET,
  "claude-sonnet-4-5": COST_SONNET,
  "claude-sonnet-4-6": COST_SONNET,
  // Opus
  "claude-opus-4": COST_OPUS_LEGACY,
  "claude-opus-4-1": COST_OPUS_LEGACY,
  "claude-opus-4-5": COST_OPUS,
  "claude-opus-4-6": COST_OPUS,
};

// ── Usage Types ──

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  webSearchRequests: number;
}

export interface ModelUsage extends TokenUsage {
  costUsd: number;
  turnCount: number;
}

export interface SessionCostSummary {
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  totalWebSearchRequests: number;
  totalTurns: number;
  modelUsage: Record<string, ModelUsage>;
  durationMs: number;
}

// ── Cost Tracker ──

export class CostTracker {
  private modelUsage = new Map<string, ModelUsage>();
  private startTime = Date.now();
  private unknownModels = new Set<string>();

  /**
   * Get the pricing tier for a model.
   */
  getModelCosts(model: string): ModelCosts {
    const canonical = canonicalizeModel(model);
    const costs = MODEL_PRICING[canonical];
    if (!costs) {
      this.unknownModels.add(model);
      return DEFAULT_COSTS;
    }
    return costs;
  }

  /**
   * Record a turn's token usage and compute the cost.
   * Returns the cost in USD for this turn.
   */
  addTurn(
    model: string,
    usage: {
      input_tokens: number;
      output_tokens: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
      server_tool_use?: { web_search_requests?: number };
    },
  ): number {
    const costs = this.getModelCosts(model);
    const cost = computeCost(costs, usage);

    const canonical = canonicalizeModel(model);
    const existing = this.modelUsage.get(canonical) ?? {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      webSearchRequests: 0,
      costUsd: 0,
      turnCount: 0,
    };

    existing.inputTokens += usage.input_tokens;
    existing.outputTokens += usage.output_tokens;
    existing.cacheReadTokens += usage.cache_read_input_tokens ?? 0;
    existing.cacheWriteTokens += usage.cache_creation_input_tokens ?? 0;
    existing.webSearchRequests += usage.server_tool_use?.web_search_requests ?? 0;
    existing.costUsd += cost;
    existing.turnCount += 1;

    this.modelUsage.set(canonical, existing);
    return cost;
  }

  /**
   * Add cost from SDK result events that provide total_cost_usd directly.
   */
  addFromSdkResult(
    totalCostUsd: number,
    usage: { input_tokens: number; output_tokens: number },
    model: string,
  ): void {
    const canonical = canonicalizeModel(model);
    const existing = this.modelUsage.get(canonical) ?? {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      webSearchRequests: 0,
      costUsd: 0,
      turnCount: 0,
    };

    existing.inputTokens += usage.input_tokens;
    existing.outputTokens += usage.output_tokens;
    existing.costUsd += totalCostUsd;
    existing.turnCount += 1;
    this.modelUsage.set(canonical, existing);
  }

  /** Get the full session cost summary. */
  getSummary(): SessionCostSummary {
    let totalCostUsd = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCacheReadTokens = 0;
    let totalCacheWriteTokens = 0;
    let totalWebSearchRequests = 0;
    let totalTurns = 0;
    const modelUsage: Record<string, ModelUsage> = {};

    for (const [model, usage] of this.modelUsage) {
      totalCostUsd += usage.costUsd;
      totalInputTokens += usage.inputTokens;
      totalOutputTokens += usage.outputTokens;
      totalCacheReadTokens += usage.cacheReadTokens;
      totalCacheWriteTokens += usage.cacheWriteTokens;
      totalWebSearchRequests += usage.webSearchRequests;
      totalTurns += usage.turnCount;
      modelUsage[model] = { ...usage };
    }

    return {
      totalCostUsd,
      totalInputTokens,
      totalOutputTokens,
      totalCacheReadTokens,
      totalCacheWriteTokens,
      totalWebSearchRequests,
      totalTurns,
      modelUsage,
      durationMs: Date.now() - this.startTime,
    };
  }

  /** Get total cost in USD. */
  getTotalCost(): number {
    let total = 0;
    for (const usage of this.modelUsage.values()) {
      total += usage.costUsd;
    }
    return total;
  }

  /** Whether any unknown models were used (costs may be inaccurate). */
  hasUnknownModels(): boolean {
    return this.unknownModels.size > 0;
  }

  /** Reset all tracked state. */
  reset(): void {
    this.modelUsage.clear();
    this.unknownModels.clear();
    this.startTime = Date.now();
  }

  /** Restore state from a previously saved summary. */
  restore(summary: SessionCostSummary): void {
    this.modelUsage.clear();
    for (const [model, usage] of Object.entries(summary.modelUsage)) {
      this.modelUsage.set(model, { ...usage });
    }
  }
}

// ── Formatting ──

/**
 * Format a cost in USD for display.
 */
export function formatCost(cost: number): string {
  if (cost >= 0.5) {
    return `$${cost.toFixed(2)}`;
  }
  return `$${cost.toFixed(4)}`;
}

/**
 * Format a duration in milliseconds for display.
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60);
  return `${minutes}m ${remainingSeconds}s`;
}

/**
 * Format a full session cost summary for CLI display.
 */
export function formatSessionSummary(summary: SessionCostSummary): string {
  const lines: string[] = [];

  const costStr = formatCost(summary.totalCostUsd);
  lines.push(`Total cost:    ${costStr}`);
  lines.push(`Duration:      ${formatDuration(summary.durationMs)}`);
  lines.push(`Turns:         ${summary.totalTurns}`);
  lines.push("");

  // Per-model breakdown
  const models = Object.entries(summary.modelUsage);
  if (models.length > 0) {
    lines.push("Usage by model:");
    for (const [model, usage] of models) {
      const short = model.replace("claude-", "");
      lines.push(
        `  ${short}: ${formatTokenCount(usage.inputTokens)} in, ${formatTokenCount(usage.outputTokens)} out` +
          (usage.cacheReadTokens > 0
            ? `, ${formatTokenCount(usage.cacheReadTokens)} cache read`
            : "") +
          (usage.cacheWriteTokens > 0
            ? `, ${formatTokenCount(usage.cacheWriteTokens)} cache write`
            : "") +
          ` (${formatCost(usage.costUsd)})`,
      );
    }
  }

  return lines.join("\n");
}

/**
 * Format model pricing for display (e.g., "$3/$15 per Mtok").
 */
export function formatModelPricing(model: string): string | undefined {
  const canonical = canonicalizeModel(model);
  const costs = MODEL_PRICING[canonical];
  if (!costs) return undefined;

  const fmtPrice = (n: number) => (Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`);
  return `${fmtPrice(costs.inputTokens)}/${fmtPrice(costs.outputTokens)} per Mtok`;
}

// ── Helpers ──

/**
 * Canonicalize a model name by stripping version suffixes and dates.
 * e.g., "claude-sonnet-4-6-20250514" → "claude-sonnet-4-6"
 */
function canonicalizeModel(model: string): string {
  return model.replace(/-\d{8}$/, "").replace(/-latest$/, "");
}

/**
 * Compute USD cost for a single turn.
 */
function computeCost(
  costs: ModelCosts,
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    server_tool_use?: { web_search_requests?: number };
  },
): number {
  return (
    (usage.input_tokens / 1_000_000) * costs.inputTokens +
    (usage.output_tokens / 1_000_000) * costs.outputTokens +
    ((usage.cache_read_input_tokens ?? 0) / 1_000_000) * costs.cacheReadTokens +
    ((usage.cache_creation_input_tokens ?? 0) / 1_000_000) * costs.cacheWriteTokens +
    (usage.server_tool_use?.web_search_requests ?? 0) * costs.webSearchRequests
  );
}

// ── Singleton ──

let _tracker: CostTracker | undefined;

/** Get or create the global cost tracker singleton. */
export function getCostTracker(): CostTracker {
  if (!_tracker) {
    _tracker = new CostTracker();
  }
  return _tracker;
}

/** Reset the global cost tracker (for testing or session reset). */
export function resetCostTracker(): void {
  _tracker = undefined;
}
