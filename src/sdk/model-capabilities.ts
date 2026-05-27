/**
 * Per-model capability registry.
 *
 * Single source of truth for "what does this model support" — context
 * window size, max output tokens, beta tiers that unlock larger windows,
 * display label, family. Surfaces:
 *
 * - Cost tracking (pricing tier mapping)
 * - Context-window visualization (current usage vs. capacity)
 * - Settings UI model picker labels
 * - System prompt routing decisions
 *
 * Add a new model here when a new release ships; the rest of the app
 * picks it up automatically through `getContextWindow()` / `listModels()`.
 */
export interface ModelCapability {
  /** Canonical model id (matches the SDK's expected name). */
  id: string;
  /** Human-readable label for UIs. */
  label: string;
  /** Family bucket — drives the cost-tier mapping. */
  family: "opus" | "sonnet" | "haiku";
  /** Base context window in tokens (no betas). */
  contextWindow: number;
  /**
   * If set, the model supports a larger context window when this beta
   * flag is enabled. Currently only `context-1m-2025-08-07` unlocks 1M.
   */
  extendedContextWindow?: {
    /** SDK beta name that unlocks it. */
    beta: "context-1m-2025-08-07";
    /** Window size when that beta is active. */
    window: number;
  };
  /** Max output tokens per response. */
  maxOutputTokens: number;
  /** When the model was published (YYYY-MM); used for sort order in UIs. */
  releasedYearMonth: string;
}

/**
 * Registry of known Claude models. Newest first; matches what the cost
 * tracker recognizes (see `src/sdk/cost-tracker.ts`).
 *
 * Context windows reflect Anthropic's current docs
 * (https://docs.claude.com/en/docs/build-with-claude/context-windows):
 *   - Opus 4.7, Opus 4.6, Sonnet 4.6 → 1M tokens by default, no beta
 *   - Other models (Sonnet 4.5 deprecated, Haiku 4.5, older Opus) → 200K
 *
 * The historical `context-1m-2025-08-07` beta was for the old Sonnet 4
 * era and is now mostly retired — current 1M-capable models don't need
 * it, and 200K models don't expose a 1M variant. We keep
 * `extendedContextWindow` as a schema field for future betas but don't
 * populate it for any current model.
 */
export const MODEL_CAPABILITIES: ModelCapability[] = [
  {
    id: "claude-opus-4-7",
    label: "Claude Opus 4.7",
    family: "opus",
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    releasedYearMonth: "2026-05",
  },
  {
    id: "claude-opus-4-6",
    label: "Claude Opus 4.6",
    family: "opus",
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    releasedYearMonth: "2026-02",
  },
  {
    id: "claude-opus-4-5",
    label: "Claude Opus 4.5",
    family: "opus",
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    releasedYearMonth: "2025-11",
  },
  {
    id: "claude-sonnet-4-6",
    label: "Claude Sonnet 4.6",
    family: "sonnet",
    contextWindow: 1_000_000,
    maxOutputTokens: 64_000,
    releasedYearMonth: "2026-01",
  },
  {
    id: "claude-sonnet-4-5",
    label: "Claude Sonnet 4.5",
    family: "sonnet",
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    releasedYearMonth: "2025-09",
  },
  {
    id: "claude-haiku-4-5",
    label: "Claude Haiku 4.5",
    family: "haiku",
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    releasedYearMonth: "2025-10",
  },
];

/** Look up by id; matches the cost-tracker's canonicalization (drops date suffix). */
export function getModelCapability(model: string): ModelCapability | undefined {
  const id = canonicalizeModelId(model);
  return MODEL_CAPABILITIES.find((m) => m.id === id);
}

/**
 * Effective context window for a model, accounting for active betas.
 * Falls back to 200K if the model is unknown (safe lower bound — won't
 * under-report for any current model).
 */
export function getContextWindow(model: string, betas?: readonly string[]): number {
  const cap = getModelCapability(model);
  if (!cap) return 200_000;
  if (cap.extendedContextWindow && betas?.includes(cap.extendedContextWindow.beta)) {
    return cap.extendedContextWindow.window;
  }
  return cap.contextWindow;
}

/** Stable, UI-friendly ordering: newest first within each family, opus → sonnet → haiku. */
export function listModels(): ModelCapability[] {
  const familyOrder = { opus: 0, sonnet: 1, haiku: 2 };
  return [...MODEL_CAPABILITIES].sort((a, b) => {
    const fam = familyOrder[a.family] - familyOrder[b.family];
    if (fam !== 0) return fam;
    return b.releasedYearMonth.localeCompare(a.releasedYearMonth);
  });
}

/**
 * Strip date suffixes the API sometimes returns (e.g. "claude-sonnet-4-6-20250514").
 * Mirrors the logic in `cost-tracker.ts` so both lookups agree.
 */
export function canonicalizeModelId(model: string): string {
  // Trim trailing `-YYYYMMDD` date suffix if present.
  return model.replace(/-\d{8}$/, "");
}
