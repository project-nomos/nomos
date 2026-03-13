import { vi, describe, it, expect, beforeEach } from "vitest";

const mockSql = Object.assign(vi.fn(), { unsafe: vi.fn() });
vi.mock("./client.ts", () => ({ getDb: () => mockSql }));

import {
  storeMemoryChunk,
  searchMemoryByVector,
  searchMemoryByText,
  deleteMemoryBySource,
  deleteMemoryByPath,
} from "./memory.ts";

beforeEach(() => {
  mockSql.mockReset();
  mockSql.unsafe.mockReset();
});

describe("storeMemoryChunk", () => {
  it("calls sql to store chunk without embedding", async () => {
    mockSql.mockResolvedValueOnce([]);
    await storeMemoryChunk({
      id: "chunk-1",
      source: "conversation",
      text: "Some text to remember",
    });
    expect(mockSql).toHaveBeenCalled();
  });

  it("calls sql to store chunk with embedding", async () => {
    mockSql.mockResolvedValueOnce([]);
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
    expect(mockSql).toHaveBeenCalled();
  });
});

describe("searchMemoryByVector", () => {
  it("returns scored search results", async () => {
    const rows = [
      { id: "chunk-1", text: "Hello", path: null, source: "conversation", score: 0.95 },
      { id: "chunk-2", text: "World", path: "/a.ts", source: "file", score: 0.8 },
    ];
    mockSql.mockResolvedValueOnce(rows);
    const result = await searchMemoryByVector([0.1, 0.2], 10);
    expect(result).toEqual(rows);
    expect(mockSql).toHaveBeenCalled();
  });
});

describe("searchMemoryByText", () => {
  it("returns scored search results", async () => {
    const rows = [
      { id: "chunk-1", text: "matching text", path: null, source: "conversation", score: 0.5 },
    ];
    mockSql.mockResolvedValueOnce(rows);
    const result = await searchMemoryByText("matching", 5);
    expect(result).toEqual(rows);
    expect(mockSql).toHaveBeenCalled();
  });
});

describe("deleteMemoryBySource", () => {
  it("returns count of deleted rows", async () => {
    mockSql.mockResolvedValueOnce({ count: 5 });
    const result = await deleteMemoryBySource("conversation");
    expect(result).toBe(5);
  });
});

describe("deleteMemoryByPath", () => {
  it("returns count of deleted rows", async () => {
    mockSql.mockResolvedValueOnce({ count: 2 });
    const result = await deleteMemoryByPath("/src/old.ts");
    expect(result).toBe(2);
  });
});
