import { vi, describe, it, expect, beforeEach } from "vitest";

const mockSql = Object.assign(vi.fn(), { unsafe: vi.fn() });
vi.mock("./client.ts", () => ({ getDb: () => mockSql }));

import {
  createSession,
  getSession,
  getSessionByKey,
  listSessions,
  updateSessionUsage,
  updateSessionModel,
  updateSessionSdkId,
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
  created_at: new Date(),
  updated_at: new Date(),
};

beforeEach(() => {
  mockSql.mockReset();
  mockSql.unsafe.mockReset();
});

describe("createSession", () => {
  it("returns the created session row", async () => {
    mockSql.mockResolvedValueOnce([fakeSession]);
    const result = await createSession({ sessionKey: "cli:default" });
    expect(result).toEqual(fakeSession);
    expect(mockSql).toHaveBeenCalled();
  });
});

describe("getSession", () => {
  it("returns session when found", async () => {
    mockSql.mockResolvedValueOnce([fakeSession]);
    const result = await getSession("uuid-1");
    expect(result).toEqual(fakeSession);
  });

  it("returns null when not found", async () => {
    mockSql.mockResolvedValueOnce([]);
    const result = await getSession("missing");
    expect(result).toBeNull();
  });
});

describe("getSessionByKey", () => {
  it("returns session when found", async () => {
    mockSql.mockResolvedValueOnce([fakeSession]);
    const result = await getSessionByKey("cli:default");
    expect(result).toEqual(fakeSession);
  });

  it("returns null when not found", async () => {
    mockSql.mockResolvedValueOnce([]);
    const result = await getSessionByKey("nonexistent");
    expect(result).toBeNull();
  });
});

describe("listSessions", () => {
  it("returns list of sessions", async () => {
    mockSql.mockResolvedValueOnce([fakeSession]);
    const result = await listSessions();
    expect(result).toEqual([fakeSession]);
  });

  it("respects status and limit params", async () => {
    mockSql.mockResolvedValueOnce([]);
    const result = await listSessions({ status: "archived", limit: 10 });
    expect(result).toEqual([]);
    expect(mockSql).toHaveBeenCalled();
  });
});

describe("updateSessionUsage", () => {
  it("calls sql to update token usage", async () => {
    mockSql.mockResolvedValueOnce([]);
    await updateSessionUsage("uuid-1", 100, 200);
    expect(mockSql).toHaveBeenCalled();
  });
});

describe("updateSessionModel", () => {
  it("calls sql to update model", async () => {
    mockSql.mockResolvedValueOnce([]);
    await updateSessionModel("uuid-1", "claude-opus-4-6");
    expect(mockSql).toHaveBeenCalled();
  });
});

describe("updateSessionSdkId", () => {
  it("calls sql to update SDK session ID", async () => {
    mockSql.mockResolvedValueOnce([]);
    await updateSessionSdkId("cli:default", "sdk-123");
    expect(mockSql).toHaveBeenCalled();
  });
});

describe("archiveSession", () => {
  it("calls sql to archive session", async () => {
    mockSql.mockResolvedValueOnce([]);
    await archiveSession("uuid-1");
    expect(mockSql).toHaveBeenCalled();
  });
});

describe("deleteSession", () => {
  it("calls sql to delete session", async () => {
    mockSql.mockResolvedValueOnce([]);
    await deleteSession("uuid-1");
    expect(mockSql).toHaveBeenCalled();
  });
});
