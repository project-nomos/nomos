import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the SDK so the vision call is exercised without creds or a network.
const { generateContent } = vi.hoisted(() => ({ generateContent: vi.fn() }));
vi.mock("@google/genai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@google/genai")>();
  return {
    ...actual,
    GoogleGenAI: vi.fn(function () {
      return { models: { generateContent } };
    }),
  };
});

import { parseSuggestions, suggestEdits } from "./suggest.ts";

describe("parseSuggestions", () => {
  it("parses a JSON array of {label, prompt}", () => {
    const s = parseSuggestions('[{"label":"Brighten Face","prompt":"brighten the face"}]');
    expect(s).toEqual([{ label: "Brighten Face", prompt: "brighten the face" }]);
  });

  it("strips ```json code fences", () => {
    const s = parseSuggestions('```json\n[{"label":"Warm","prompt":"warm it up"}]\n```');
    expect(s[0]).toEqual({ label: "Warm", prompt: "warm it up" });
  });

  it("accepts a {suggestions:[...]} wrapper", () => {
    const s = parseSuggestions('{"suggestions":[{"label":"A","prompt":"b"}]}');
    expect(s).toHaveLength(1);
  });

  it("drops malformed entries and clamps to count", () => {
    const s = parseSuggestions(
      '[{"label":"A","prompt":"a"},{"label":"B"},{"x":1},{"label":"C","prompt":"c"}]',
      5,
    );
    expect(s.map((x) => x.label)).toEqual(["A", "C"]);
  });

  it("returns [] on non-JSON", () => {
    expect(parseSuggestions("sorry, I can't")).toEqual([]);
  });
});

describe("suggestEdits", () => {
  const SAVED = ["GEMINI_API_KEY", "GOOGLE_API_KEY", "NOMOS_STUDIO_PROVIDER"];
  const prev: Record<string, string | undefined> = {};

  beforeEach(() => {
    generateContent.mockReset();
    for (const k of SAVED) {
      prev[k] = process.env[k];
      delete process.env[k];
    }
    process.env.GEMINI_API_KEY = "test-key"; // gemini surface
  });
  afterEach(() => {
    for (const k of SAVED) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  });

  it("returns parsed suggestions and requests JSON output", async () => {
    generateContent.mockResolvedValue({ text: '[{"label":"Brighten","prompt":"brighten it"}]' });
    const s = await suggestEdits(new Uint8Array([1, 2, 3]), "image/jpeg");
    expect(s).toEqual([{ label: "Brighten", prompt: "brighten it" }]);
    const arg = generateContent.mock.calls[0][0] as { config?: { responseMimeType?: string } };
    expect(arg.config?.responseMimeType).toBe("application/json");
  });

  it("degrades to [] when the model throws", async () => {
    generateContent.mockRejectedValue(new Error("boom"));
    expect(await suggestEdits(new Uint8Array([1]), "image/jpeg")).toEqual([]);
  });
});
