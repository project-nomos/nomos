/**
 * Shared experience: an agent-authored relationship narrative.
 *
 * The agent already DEEPENS its understanding of the user (user_model accumulation +
 * background consolidation) but never ARTICULATES it — understanding != articulation.
 * This generates a short, evidence-grounded narrative in the agent's own voice ("here's
 * how we've come to work together") from the learned user_model, written to an editable
 * `relationship.md` vault note (and indexed for recall). Background, per-owner,
 * NOMOS_ADAPTIVE_MEMORY-gated, user_id-scoped.
 */

import { getUserModel } from "../db/user-model.ts";
import { loadEnvConfig } from "../config/env.ts";
import { createLogger } from "../lib/logger.ts";
import { runForkedAgent } from "../sdk/forked-agent.ts";
import { vaultWrite } from "./vault.ts";

const log = createLogger("relationship-narrative");

const NOTE = "relationship.md";
const MIN_ENTRIES = 5; // not worth narrating below this much learned

// STABLE rubric — byte-identical every call so the SDK caches it in the
// system-prompt prefix. Only the dynamic learned-facts block goes in the prompt.
const INSTRUCTIONS = `You are an AI companion reflecting, in YOUR OWN VOICE (first person), on how you've come to understand and work with this specific person. Ground EVERY claim in the learned facts provided — do not invent. Write 4-8 sentences covering: who they are to you, the patterns you've learned in how they work and decide, what you've adjusted as a result, and where you can be most useful. Warm but honest — no flattery, no "as an AI", no disclaimers. Output ONLY the prose.`;

function formatValue(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export interface NarrativeResult {
  wrote: boolean;
  reason?: string;
}

/**
 * Generate (or refresh) the per-owner relationship narrative from the learned user_model
 * and write it to `relationship.md`. No-op when adaptive memory is off or there isn't
 * enough learned yet.
 */
export async function writeRelationshipNarrative(userId: string): Promise<NarrativeResult> {
  const config = loadEnvConfig();
  if (!config.adaptiveMemory) return { wrote: false, reason: "adaptive memory off" };

  const entries = await getUserModel(userId);
  if (entries.length < MIN_ENTRIES) return { wrote: false, reason: "not enough learned yet" };

  const facts = entries
    .slice(0, 40)
    .map(
      (e) =>
        `- [${e.category}] ${e.key}: ${formatValue(e.value)} (confidence ${(e.confidence ?? 1).toFixed(2)})`,
    )
    .join("\n");

  const result = await runForkedAgent({
    label: "relationship-narrative",
    model: config.extractionModel ?? "claude-haiku-4-5",
    allowedTools: [],
    maxTurns: 1,
    systemPromptAppend: INSTRUCTIONS,
    prompt: `WHAT YOU'VE LEARNED ABOUT THEM:\n${facts}`,
  });

  const narrative = result.text.trim();
  if (narrative.length < 40) {
    log.debug({ chars: narrative.length }, "narrative too short; skipping");
    return { wrote: false, reason: "empty narrative" };
  }

  await vaultWrite(userId, NOTE, narrative.slice(0, 3000), { title: "Our working relationship" });
  return { wrote: true };
}
