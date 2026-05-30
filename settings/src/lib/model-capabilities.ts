/**
 * Settings-side mirror of `src/sdk/model-capabilities.ts` in the main
 * package. Kept duplicated because the Settings UI is a separate Next.js
 * app and can't import TS modules from the daemon directly.
 *
 * When you add a model in one place, add it in the other. The shapes are
 * identical so future-you can scan both files in one diff.
 */
export interface ModelCapability {
  id: string;
  label: string;
  family: "opus" | "sonnet" | "haiku";
  contextWindow: number;
  extendedContextWindow?: {
    beta: "context-1m-2025-08-07";
    window: number;
  };
  maxOutputTokens: number;
  releasedYearMonth: string;
}

// Context windows match Anthropic's docs:
// https://docs.claude.com/en/docs/build-with-claude/context-windows
//   - Opus 4.8, Opus 4.6, Sonnet 4.6 → 1M tokens by default, no beta
//   - Other models (Sonnet 4.5 deprecated, Haiku 4.5, older Opus) → 200K
// The historical `context-1m-2025-08-07` beta is retired; current 1M
// models don't need it and 200K models don't expose a 1M variant.
export const MODEL_CAPABILITIES: ModelCapability[] = [
  {
    id: "claude-opus-4-8",
    label: "Claude Opus 4.8",
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

export function canonicalizeModelId(model: string): string {
  return model.replace(/-\d{8}$/, "");
}

export function getModelCapability(model: string): ModelCapability | undefined {
  const id = canonicalizeModelId(model);
  return MODEL_CAPABILITIES.find((m) => m.id === id);
}

export function getContextWindow(model: string, betas?: readonly string[]): number {
  const cap = getModelCapability(model);
  if (!cap) return 200_000;
  if (cap.extendedContextWindow && betas?.includes(cap.extendedContextWindow.beta)) {
    return cap.extendedContextWindow.window;
  }
  return cap.contextWindow;
}

export function listModels(): ModelCapability[] {
  const familyOrder = { opus: 0, sonnet: 1, haiku: 2 };
  return [...MODEL_CAPABILITIES].sort((a, b) => {
    const fam = familyOrder[a.family] - familyOrder[b.family];
    if (fam !== 0) return fam;
    return b.releasedYearMonth.localeCompare(a.releasedYearMonth);
  });
}

/**
 * Format a context window number for display, e.g. 200000 → "200K",
 * 1000000 → "1M". Consistent across the Settings UI.
 */
export function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000)
    return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(tokens);
}
