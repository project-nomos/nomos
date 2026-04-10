import { vi, describe, it, expect, beforeEach } from "vitest";
import { createMockDb } from "./test-helpers.ts";

const { db, addResult, reset } = createMockDb();
vi.mock("./client.ts", () => ({ getKysely: () => db }));

import { getConfigValue, setConfigValue, deleteConfigValue, listConfig } from "./config.ts";

beforeEach(() => {
  reset();
});

describe("getConfigValue", () => {
  it("returns value when row exists", async () => {
    addResult([{ value: "hello" }]);
    const result = await getConfigValue("my-key");
    expect(result).toBe("hello");
  });

  it("returns null when no row found", async () => {
    addResult([]);
    const result = await getConfigValue("missing");
    expect(result).toBeNull();
  });
});

describe("setConfigValue", () => {
  it("calls db to upsert config", async () => {
    addResult([]);
    await setConfigValue("key1", { foo: "bar" });
    // No error means the query compiled and executed
  });
});

describe("deleteConfigValue", () => {
  it("calls db to delete config", async () => {
    addResult([]);
    await deleteConfigValue("key1");
  });
});

describe("listConfig", () => {
  it("returns sorted config entries", async () => {
    const rows = [
      { key: "a", value: 1 },
      { key: "b", value: 2 },
    ];
    addResult(rows);
    const result = await listConfig();
    expect(result).toEqual(rows);
  });
});
