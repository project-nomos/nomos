/**
 * LLM-as-a-Judge.
 *
 * Grades an agent response against a rubric and returns a structured verdict.
 * Tests assert plumbing (a query returned the right row); the judge assesses
 * BEHAVIOR (did the clone actually recall the fact, stay continuous, respect the
 * owner boundary). Uses the project's lightweight forked-agent path (Haiku by
 * default) so it inherits provider switching (Anthropic / Vertex).
 */

import { runForkedAgent } from "../src/sdk/forked-agent.ts";

export interface Verdict {
  pass: boolean;
  /** 0..1 quality score. */
  score: number;
  reasoning: string;
}

export interface JudgeInput {
  /** What the agent was asked / the situation. */
  context: string;
  /** The agent's actual response (or the data under test). */
  response: string;
  /** The rubric: what a passing response must do. */
  rubric: string;
}

const JUDGE_SYSTEM =
  "You are a strict evaluation judge for an AI assistant's memory system. " +
  "Grade ONLY against the rubric. Reply with a SINGLE JSON object and nothing " +
  "before or after it: no code fences, no explanation.";

/**
 * Extract the first balanced JSON object from arbitrary model text. Ignores
 * braces inside strings, so it survives code fences and trailing prose (which a
 * greedy `{...}` regex does not).
 */
export function extractJson(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

/** Grade a single response. Never throws; returns a fail verdict on any error. */
export async function judge(input: JudgeInput, model = "claude-haiku-4-5"): Promise<Verdict> {
  const prompt = `Evaluate whether the RESPONSE satisfies the RUBRIC for the given CONTEXT.

CONTEXT:
${input.context}

RUBRIC (a passing response must satisfy this):
${input.rubric}

RESPONSE:
${input.response}

Return ONLY this JSON:
{"pass": true|false, "score": 0.0-1.0, "reasoning": "one or two sentences"}`;

  try {
    const result = await runForkedAgent({
      prompt,
      systemPromptAppend: JUDGE_SYSTEM,
      model,
      maxTurns: 1,
      label: "judge",
    });
    const jsonText = extractJson(result.text);
    if (!jsonText) return { pass: false, score: 0, reasoning: "judge returned no JSON" };
    const parsed = JSON.parse(jsonText) as Partial<Verdict>;
    return {
      pass: parsed.pass === true,
      score: typeof parsed.score === "number" ? parsed.score : parsed.pass ? 1 : 0,
      reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "",
    };
  } catch (err) {
    return {
      pass: false,
      score: 0,
      reasoning: `judge error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
