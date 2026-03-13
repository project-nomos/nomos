import { vi, describe, it, expect, beforeEach } from "vitest";

const mockSql = Object.assign(vi.fn(), { unsafe: vi.fn() });
vi.mock("./client.ts", () => ({ getDb: () => mockSql }));

// Mock node:fs
vi.mock("node:fs", () => ({
  default: {
    readFileSync: vi.fn(),
  },
}));

import fs from "node:fs";
import { runMigrations } from "./migrate.ts";

beforeEach(() => {
  mockSql.mockReset();
  mockSql.unsafe.mockReset();
  vi.mocked(fs.readFileSync).mockReset();
});

describe("runMigrations", () => {
  it("reads schema.sql and executes it via sql.unsafe()", async () => {
    const schemaContent = "CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY);";
    vi.mocked(fs.readFileSync).mockReturnValueOnce(schemaContent);
    mockSql.unsafe.mockResolvedValueOnce([]);

    await runMigrations();

    expect(fs.readFileSync).toHaveBeenCalledWith(expect.stringContaining("schema.sql"), "utf-8");
    expect(mockSql.unsafe).toHaveBeenCalledWith(schemaContent);
  });

  it("falls back to inline schema when file is missing", async () => {
    vi.mocked(fs.readFileSync).mockImplementationOnce(() => {
      throw new Error("ENOENT: no such file");
    });
    mockSql.unsafe.mockResolvedValueOnce([]);

    await runMigrations();

    expect(mockSql.unsafe).toHaveBeenCalledWith(expect.stringContaining("CREATE EXTENSION"));
    expect(mockSql.unsafe).toHaveBeenCalledWith(
      expect.stringContaining("CREATE TABLE IF NOT EXISTS config"),
    );
    expect(mockSql.unsafe).toHaveBeenCalledWith(
      expect.stringContaining("CREATE TABLE IF NOT EXISTS sessions"),
    );
  });
});
