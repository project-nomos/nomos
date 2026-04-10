import { vi, describe, it, expect, beforeEach } from "vitest";
import { createMockDb } from "./test-helpers.ts";

const { db, addResult, reset } = createMockDb();
vi.mock("./client.ts", () => ({ getKysely: () => db }));

import {
  createSession,
  getSession,
  getSessionByKey,
  listSessions,
  updateSessionUsage,
  updateSessionModel,
  updateSessionSdkId,
  updateSessionCost,
  archiveSession,
  deleteSession,
} from "./sessions.ts";

const fakeSession = {
  id: "uuid-1",
  session_key: "cli:default",
  agent_id: "default",
  model: "claude-sonnet-4-6",
  status: "active",
  metadata: {},
  token_usage: { input: 0, output: 0 },
  total_cost_usd: 0,
  input_tokens: 0,
  output_tokens: 0,
  turn_count: 0,
  created_at: new Date(),
  updated_at: new Date(),
};

beforeEach(() => {
  reset();
});

describe("createSession", () => {
  it("returns the created session row", async () => {
    addResult([fakeSession]);
    const result = await createSession({ sessionKey: "cli:default" });
    expect(result).toEqual(fakeSession);
  });
});

describe("getSession", () => {
  it("returns session when found", async () => {
    addResult([fakeSession]);
    const result = await getSession("uuid-1");
    expect(result).toEqual(fakeSession);
  });

  it("returns null when not found", async () => {
    addResult([]);
    const result = await getSession("missing");
    expect(result).toBeNull();
  });
});

describe("getSessionByKey", () => {
  it("returns session when found", async () => {
    addResult([fakeSession]);
    const result = await getSessionByKey("cli:default");
    expect(result).toEqual(fakeSession);
  });

  it("returns null when not found", async () => {
    addResult([]);
    const result = await getSessionByKey("nonexistent");
    expect(result).toBeNull();
  });
});

describe("listSessions", () => {
  it("returns list of sessions", async () => {
    addResult([fakeSession]);
    const result = await listSessions();
    expect(result).toEqual([fakeSession]);
  });

  it("respects status and limit params", async () => {
    addResult([]);
    const result = await listSessions({ status: "archived", limit: 10 });
    expect(result).toEqual([]);
  });
});

describe("updateSessionUsage", () => {
  it("executes update query", async () => {
    addResult([]);
    await updateSessionUsage("uuid-1", 100, 200);
  });
});

describe("updateSessionModel", () => {
  it("executes update query", async () => {
    addResult([]);
    await updateSessionModel("uuid-1", "claude-opus-4-6");
  });
});

describe("updateSessionSdkId", () => {
  it("executes update query", async () => {
    addResult([]);
    await updateSessionSdkId("cli:default", "sdk-123");
  });
});

describe("archiveSession", () => {
  it("executes update query", async () => {
    addResult([]);
    await archiveSession("uuid-1");
  });
});

describe("updateSessionCost", () => {
  it("executes update query", async () => {
    addResult([]);
    await updateSessionCost("cli:abc123", 0.0042, 500, 200);
  });
});

describe("deleteSession", () => {
  it("executes delete query", async () => {
    addResult([]);
    await deleteSession("uuid-1");
  });
});
