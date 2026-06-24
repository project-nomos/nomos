/**
 * `/homework` command expansion — pure helper, no heavy imports.
 *
 * `/homework` is a power-user CLI REPL convenience (hosted mode has no slash
 * commands). It expands to a consent-first instruction: find pending work, draft it,
 * and submit only after the user confirms. Tool-agnostic — power-user drives the gws
 * CLI (via the gws-classroom skill); the prompt just kicks off the workflow.
 */

/** Expand `/homework [extra]` into the agent instruction (draft pending work, confirm before submitting). */
export function buildHomeworkPrompt(extra: string): string {
  const base = [
    "Help me with my Google Classroom homework.",
    "1. Find my courses and the assignments due soon that I have NOT turned in (list coursework ordered by due date, cross-referenced with my submissions).",
    "2. For each, read the assignment (and its materials) and draft my work.",
    "3. Show me each draft. Submit ONLY after I confirm — never turn in anything without my explicit approval.",
  ].join("\n");
  return extra ? `${base}\n\nAdditional instruction: ${extra}` : base;
}
