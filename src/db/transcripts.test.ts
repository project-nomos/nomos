import { vi, describe, it, expect, beforeEach } from "vitest";

const mockSql = Object.assign(vi.fn(), { unsafe: vi.fn() });
vi.mock("./client.ts", () => ({ getDb: () => mockSql }));

import {
  appendTranscriptMessage,
  getTranscript,
  getTranscriptWithUsage,
  countTranscriptMessages,
  deleteLastTranscriptMessages,
} from "./transcripts.ts";

beforeEach(() => {
  mockSql.mockReset();
  mockSql.unsafe.mockReset();
});

describe("appendTranscriptMessage", () => {
  it("calls sql to insert a message", async () => {
    mockSql.mockResolvedValueOnce([]);
    await appendTranscriptMessage({
      sessionId: "uuid-1",
      role: "user",
      content: "Hello",
    });
    expect(mockSql).toHaveBeenCalled();
  });

  it("handles content with usage", async () => {
    mockSql.mockResolvedValueOnce([]);
    await appendTranscriptMessage({
      sessionId: "uuid-1",
      role: "assistant",
      content: [{ type: "text", text: "Hi" }],
      usage: { input: 10, output: 20 },
    });
    expect(mockSql).toHaveBeenCalled();
  });
});

describe("getTranscript", () => {
  it("returns mapped rows with role and content", async () => {
    const rows = [
      {
        id: 1,
        session_id: "uuid-1",
        role: "user",
        content: "Hello",
        usage: null,
        created_at: new Date(),
      },
      {
        id: 2,
        session_id: "uuid-1",
        role: "assistant",
        content: "Hi!",
        usage: null,
        created_at: new Date(),
      },
    ];
    // First call is for the inner sql`` fragment, second is the outer query
    mockSql.mockResolvedValueOnce("fragment").mockResolvedValueOnce(rows);
    const result = await getTranscript("uuid-1");
    expect(result).toEqual([
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi!" },
    ]);
  });

  it("returns empty array when no messages", async () => {
    // First call is for the inner sql`` fragment, second is the outer query
    mockSql.mockResolvedValueOnce("fragment").mockResolvedValueOnce([]);
    const result = await getTranscript("uuid-1");
    expect(result).toEqual([]);
  });
});

describe("getTranscriptWithUsage", () => {
  it("returns full rows", async () => {
    const rows = [
      {
        id: 1,
        session_id: "uuid-1",
        role: "user",
        content: "Hello",
        usage: null,
        created_at: new Date(),
      },
    ];
    mockSql.mockResolvedValueOnce(rows);
    const result = await getTranscriptWithUsage("uuid-1");
    expect(result).toEqual(rows);
  });
});

describe("countTranscriptMessages", () => {
  it("returns the count", async () => {
    mockSql.mockResolvedValueOnce([{ count: 42 }]);
    const result = await countTranscriptMessages("uuid-1");
    expect(result).toBe(42);
  });
});

describe("deleteLastTranscriptMessages", () => {
  it("returns the number of deleted rows", async () => {
    mockSql.mockResolvedValueOnce({ count: 3 });
    const result = await deleteLastTranscriptMessages("uuid-1", 3);
    expect(result).toBe(3);
  });
});
