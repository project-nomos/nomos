import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { coerceStructuredOutput, runReasoningFork } from "./reasoning-fork.ts";
import type { ForkedAgentResult } from "./forked-agent.ts";
import { runForkedAgent } from "./forked-agent.ts";

vi.mock("./forked-agent.ts", () => ({ runForkedAgent: vi.fn() }));
const mockFork = vi.mocked(runForkedAgent);

const schema = z.object({
  items: z.array(z.string()).default([]),
  score: z.number().default(0),
});

function raw(partial: Partial<ForkedAgentResult>): ForkedAgentResult {
  return {
    text: "",
    structuredOutput: undefined,
    costUsd: 0,
    durationMs: 0,
    usage: { inputTokens: 0, outputTokens: 0 },
    ...partial,
  };
}

describe("coerceStructuredOutput", () => {
  it("prefers the SDK-validated structuredOutput object", () => {
    const out = coerceStructuredOutput(
      schema,
      raw({ structuredOutput: { items: ["a"], score: 3 } }),
    );
    expect(out).toEqual({ items: ["a"], score: 3 });
  });

  it("accepts structuredOutput delivered as a JSON string", () => {
    const out = coerceStructuredOutput(
      schema,
      raw({ structuredOutput: '{"items":["b"],"score":1}' }),
    );
    expect(out).toEqual({ items: ["b"], score: 1 });
  });

  it("falls back to the first balanced JSON in duplicated/fenced text", () => {
    // forked-agent returns text duplicated + fenced; a greedy match would splice.
    const doc = '```json\n{"items":["c"],"score":2}\n```';
    const out = coerceStructuredOutput(schema, raw({ text: `${doc}\n${doc}` }));
    expect(out).toEqual({ items: ["c"], score: 2 });
  });

  it("applies schema defaults to a partial object", () => {
    const out = coerceStructuredOutput(schema, raw({ structuredOutput: { items: ["d"] } }));
    expect(out).toEqual({ items: ["d"], score: 0 });
  });

  it("returns null when nothing parseable is present", () => {
    const out = coerceStructuredOutput(
      schema,
      raw({ text: "no json here", structuredOutput: undefined }),
    );
    expect(out).toBeNull();
  });

  it("does NOT let a root-level .default([]) mask a real text emit when structuredOutput is absent", () => {
    // Regression: the wiki planner used z.array(...).default([]). With structuredOutput
    // undefined, safeParse(undefined) succeeded with [] and the real array in the text
    // was never parsed — silently zeroing wiki compilation.
    const arraySchema = z.array(z.object({ path: z.string() })).default([]);
    const out = coerceStructuredOutput(
      arraySchema,
      raw({ structuredOutput: undefined, text: '```json\n[{"path":"contacts/ada.md"}]\n```' }),
    );
    expect(out).toEqual([{ path: "contacts/ada.md" }]);
  });

  it("returns [] via the root default only when the text genuinely has nothing", () => {
    const arraySchema = z.array(z.object({ path: z.string() })).default([]);
    // structuredOutput present + empty array → trusted directly.
    expect(coerceStructuredOutput(arraySchema, raw({ structuredOutput: [] }))).toEqual([]);
  });

  it("still validates a transform-bearing schema via safeParse (the no-outputFormat fallback path)", () => {
    // A schema with .transform() can't be sent as JSON Schema (forked-agent skips
    // outputFormat), so the fork returns text and we coerce here — safeParse applies
    // transforms fine, unlike z.toJSONSchema which throws on them.
    const transformSchema = z.object({
      name: z.string().transform((s) => s.trim().toUpperCase()),
    });
    const out = coerceStructuredOutput(transformSchema, raw({ text: '{"name":"  ada  "}' }));
    expect(out).toEqual({ name: "ADA" });
  });
});

describe("runReasoningFork forwarding", () => {
  it("maps instructions→systemPromptAppend, input→prompt, forces allowedTools:[], defaults maxTurns:1", async () => {
    mockFork.mockResolvedValue(raw({ structuredOutput: { items: ["a"], score: 1 } }));
    const { data } = await runReasoningFork({
      instructions: "RUBRIC",
      input: "DATA",
      schema,
      label: "t",
    });
    expect(mockFork).toHaveBeenCalledWith(
      expect.objectContaining({
        systemPromptAppend: "RUBRIC",
        prompt: "DATA",
        allowedTools: [],
        maxTurns: 1,
        label: "t",
        outputSchema: schema,
      }),
    );
    expect(data).toEqual({ items: ["a"], score: 1 });
  });

  it("passes maxTurns and model overrides through", async () => {
    mockFork.mockResolvedValue(raw({ text: "no json" }));
    const { data } = await runReasoningFork({
      instructions: "i",
      input: "x",
      schema,
      label: "t",
      maxTurns: 2,
      model: "claude-sonnet-4-6",
    });
    expect(mockFork).toHaveBeenCalledWith(
      expect.objectContaining({ maxTurns: 2, model: "claude-sonnet-4-6" }),
    );
    // unparseable output → coercion returns null
    expect(data).toBeNull();
  });
});
