import { vi, describe, it, expect, beforeEach } from "vitest";

const mockSql = Object.assign(vi.fn(), { unsafe: vi.fn() });
vi.mock("./client.ts", () => ({ getDb: () => mockSql }));

import { getConfigValue, setConfigValue, deleteConfigValue, listConfig } from "./config.ts";

beforeEach(() => {
  mockSql.mockReset();
  mockSql.unsafe.mockReset();
});

describe("getConfigValue", () => {
  it("returns value when row exists", async () => {
    mockSql.mockResolvedValueOnce([{ value: "hello" }]);
    const result = await getConfigValue("my-key");
    expect(result).toBe("hello");
    expect(mockSql).toHaveBeenCalled();
  });

  it("returns null when no row found", async () => {
    mockSql.mockResolvedValueOnce([]);
    const result = await getConfigValue("missing");
    expect(result).toBeNull();
  });
});

describe("setConfigValue", () => {
  it("calls sql to upsert config", async () => {
    mockSql.mockResolvedValueOnce([]);
    await setConfigValue("key1", { foo: "bar" });
    expect(mockSql).toHaveBeenCalled();
  });
});

describe("deleteConfigValue", () => {
  it("calls sql to delete config", async () => {
    mockSql.mockResolvedValueOnce([]);
    await deleteConfigValue("key1");
    expect(mockSql).toHaveBeenCalled();
  });
});

describe("listConfig", () => {
  it("returns sorted config entries", async () => {
    const rows = [
      { key: "a", value: 1 },
      { key: "b", value: 2 },
    ];
    mockSql.mockResolvedValueOnce(rows);
    const result = await listConfig();
    expect(result).toEqual(rows);
    expect(mockSql).toHaveBeenCalled();
  });
});
