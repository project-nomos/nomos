/**
 * Reasoning-first memory digest.
 *
 * A compact, ALWAYS-injected summary of what the agent knows about the user, so
 * the clone stays continuous every turn without having to call a tool (Claude's
 * own hybrid shape: an injected synthesis plus in-loop recall tools). Sourced
 * from the agent's self-maintained `profile.md` vault note and the high-confidence
 * `user_model`. Empty string when there is nothing yet.
 */

import { getUserModel } from "../db/user-model.ts";
import { vaultRead } from "./vault.ts";

function formatValue(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export async function buildMemoryDigest(
  userId: string,
  opts?: { maxEntries?: number; minConfidence?: number },
): Promise<string> {
  const maxEntries = opts?.maxEntries ?? 30;
  const minConfidence = opts?.minConfidence ?? 0.3;

  // The agent's self-maintained profile note (always injected if present).
  let profile = "";
  try {
    const note = await vaultRead(userId, "profile.md");
    if (note?.content.trim()) profile = note.content.trim();
  } catch {
    /* vault unavailable; skip */
  }

  // High-confidence structured user model, grouped by category.
  let modelSection = "";
  try {
    const entries = (await getUserModel(userId))
      .filter((e) => (e.confidence ?? 1) >= minConfidence)
      .slice(0, maxEntries);
    if (entries.length > 0) {
      const byCategory = new Map<string, string[]>();
      for (const e of entries) {
        const lines = byCategory.get(e.category) ?? [];
        lines.push(`- ${e.key}: ${formatValue(e.value)}`);
        byCategory.set(e.category, lines);
      }
      modelSection = [...byCategory]
        .map(([category, lines]) => `### ${category}\n${lines.join("\n")}`)
        .join("\n");
    }
  } catch {
    /* user_model unavailable; skip */
  }

  if (!profile && !modelSection) return "";

  const parts = [
    "## What you know about this user",
    "Your durable memory of the user, always present so you stay continuous. Treat it as known; do not ask the user to re-tell you these. Keep it current with memory_write (revise, do not duplicate).",
  ];
  if (profile) parts.push(profile);
  if (modelSection) parts.push(modelSection);
  return parts.join("\n");
}
