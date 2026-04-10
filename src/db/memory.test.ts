import { vi, describe, it, expect, beforeEach } from "vitest";
import { createMockDb } from "./test-helpers.ts";

const { db, addResult, reset } = createMockDb();
vi.mock("./client.ts", () => ({ getKysely: () => db }));

import {
  storeMemoryChunk,
  searchMemoryByVector,
  searchMemoryByText,
  deleteMemoryBySource,
  deleteMemoryByPath,
} from "./memory.ts";

beforeEach(() => {
  reset();
});

describe("storeMemoryChunk", () => {
  it("stores chunk without embedding", async () => {
    addResult([]);
    await storeMemoryChunk({
      id: "chunk-1",
      source: "conversation",
      text: "Some text to remember",
    });
  });

  it("stores chunk with embedding", async () => {
    addResult([]);
    await storeMemoryChunk({
      id: "chunk-2",
      source: "file",
      path: "/src/index.ts",
      text: "Code content",
      embedding: [0.1, 0.2, 0.3],
      startLine: 1,
      endLine: 10,
      hash: "abc123",
      model: "gemini-embedding-001",
    });
  });
});

describe("searchMemoryByVector", () => {
  it("returns scored search results", async () => {
    const rows = [
      { id: "chunk-1", text: "Hello", path: null, source: "conversation", score: 0.95 },
      { id: "chunk-2", text: "World", path: "/a.ts", source: "file", score: 0.8 },
    ];
    addResult(rows);
    const result = await searchMemoryByVector([0.1, 0.2], 10);
    expect(result).toEqual(rows);
  });
});

describe("searchMemoryByText", () => {
  it("returns scored search results", async () => {
    const rows = [
      { id: "chunk-1", text: "matching text", path: null, source: "conversation", score: 0.5 },
    ];
    addResult(rows);
    const result = await searchMemoryByText("matching", 5);
    expect(result).toEqual(rows);
  });
});

describe("deleteMemoryBySource", () => {
  it("returns count of deleted rows", async () => {
    addResult([{}, {}, {}, {}, {}]); // 5 rows → numDeletedRows = 5
    const result = await deleteMemoryBySource("conversation");
    expect(result).toBe(5);
  });
});

describe("deleteMemoryByPath", () => {
  it("returns count of deleted rows", async () => {
    addResult([{}, {}]); // 2 rows → numDeletedRows = 2
    const result = await deleteMemoryByPath("/src/old.ts");
    expect(result).toBe(2);
  });
});
