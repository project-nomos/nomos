import { vi, describe, it, expect, beforeEach } from "vitest";
import { createMockDb } from "./test-helpers.ts";

const { db, addResult, reset } = createMockDb();
vi.mock("./client.ts", () => ({ getKysely: () => db }));

import {
  appendTranscriptMessage,
  getTranscript,
  getTranscriptWithUsage,
  countTranscriptMessages,
  deleteLastTranscriptMessages,
} from "./transcripts.ts";

beforeEach(() => {
  reset();
});

describe("appendTranscriptMessage", () => {
  it("inserts a message", async () => {
    addResult([]);
    await appendTranscriptMessage({
      sessionId: "uuid-1",
      role: "user",
      content: "Hello",
    });
  });

  it("handles content with usage", async () => {
    addResult([]);
    await appendTranscriptMessage({
      sessionId: "uuid-1",
      role: "assistant",
      content: [{ type: "text", text: "Hi" }],
      usage: { input: 10, output: 20 },
    });
  });
});

describe("getTranscript", () => {
  it("returns mapped rows with role and content", async () => {
    addResult([
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi!" },
    ]);
    const result = await getTranscript("uuid-1");
    expect(result).toEqual([
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi!" },
    ]);
  });

  it("returns empty array when no messages", async () => {
    addResult([]);
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
    addResult(rows);
    const result = await getTranscriptWithUsage("uuid-1");
    expect(result).toEqual(rows);
  });
});

describe("countTranscriptMessages", () => {
  it("returns the count", async () => {
    addResult([{ count: 42 }]);
    const result = await countTranscriptMessages("uuid-1");
    expect(result).toBe(42);
  });
});

describe("deleteLastTranscriptMessages", () => {
  it("returns the number of deleted rows", async () => {
    // The delete returns via numDeletedRows, but our mock returns via rows length
    addResult([{}, {}, {}]); // 3 rows → numAffectedRows = 3
    const result = await deleteLastTranscriptMessages("uuid-1", 3);
    expect(result).toBe(3);
  });
});
