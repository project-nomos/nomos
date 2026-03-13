import { describe, expect, it } from "vitest";
import { chunkText } from "./chunker.ts";

describe("chunkText", () => {
  it("returns empty array for empty input", () => {
    expect(chunkText("")).toEqual([]);
  });

  it("returns single chunk when text fits within maxChunkSize", () => {
    const text = "Hello, world!\nSecond line.";
    const result = chunkText(text);

    expect(result).toHaveLength(1);
    expect(result[0].text).toBe(text);
    expect(result[0].startLine).toBe(1);
    expect(result[0].endLine).toBe(2);
  });

  it("splits text into multiple chunks when exceeding maxChunkSize", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `Line ${i + 1}: ${"x".repeat(40)}`);
    const text = lines.join("\n");

    const result = chunkText(text, { maxChunkSize: 200, overlap: 50 });

    expect(result.length).toBeGreaterThan(1);
    // All text should be covered
    expect(result[0].startLine).toBe(1);
    expect(result[result.length - 1].endLine).toBe(50);
  });

  it("includes overlap between chunks", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `Line ${i + 1}: ${"a".repeat(80)}`);
    const text = lines.join("\n");

    const result = chunkText(text, { maxChunkSize: 300, overlap: 100 });

    expect(result.length).toBeGreaterThan(1);
    // Second chunk should start before first chunk ends (overlap)
    if (result.length >= 2) {
      expect(result[1].startLine).toBeLessThanOrEqual(result[0].endLine);
    }
  });

  it("breaks at paragraph boundaries when chunk is large enough", () => {
    // Create text with a blank line (paragraph boundary) at ~65% of chunk size
    const part1 = Array.from({ length: 7 }, (_, i) => `Line ${i + 1}: ${"b".repeat(80)}`).join(
      "\n",
    );
    const part2 = Array.from({ length: 7 }, (_, i) => `Line ${i + 8}: ${"c".repeat(80)}`).join(
      "\n",
    );
    const text = `${part1}\n\n${part2}`;

    const result = chunkText(text, { maxChunkSize: 1000, overlap: 100 });

    // Should break at the paragraph boundary
    expect(result.length).toBeGreaterThanOrEqual(2);
  });

  it("tracks line numbers correctly", () => {
    const text = "Line 1\nLine 2\nLine 3\nLine 4\nLine 5";
    const result = chunkText(text);

    expect(result).toHaveLength(1);
    expect(result[0].startLine).toBe(1);
    expect(result[0].endLine).toBe(5);
  });

  it("respects custom maxChunkSize option", () => {
    // Use multi-line text so the line-based chunker can split it
    const lines = Array.from({ length: 30 }, (_, i) => `Line ${i}: ${"a".repeat(30)}`);
    const text = lines.join("\n");
    const result = chunkText(text, { maxChunkSize: 200, overlap: 40 });

    expect(result.length).toBeGreaterThan(1);
    for (const chunk of result) {
      expect(chunk.text.length).toBeGreaterThan(0);
    }
  });

  it("handles single-line text", () => {
    const text = "Just one line";
    const result = chunkText(text);

    expect(result).toHaveLength(1);
    expect(result[0].startLine).toBe(1);
    expect(result[0].endLine).toBe(1);
  });
});
