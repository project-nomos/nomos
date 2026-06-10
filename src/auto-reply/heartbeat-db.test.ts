import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

// Mock the DB config store + fs so the get/set logic is deterministic.
vi.mock("../db/config.ts", () => ({ getConfigValue: vi.fn(), setConfigValue: vi.fn() }));

const existsSync = vi.fn<(p: string) => boolean>(() => false);
const readFileSync = vi.fn<() => string>(() => "");
vi.mock("node:fs", () => ({
  default: {
    existsSync: (p: string) => existsSync(p),
    readFileSync: () => readFileSync(),
  },
}));

import { getConfigValue, setConfigValue } from "../db/config.ts";
import { getHeartbeat, setHeartbeat } from "./heartbeat.ts";

const mockGet = getConfigValue as unknown as Mock;
const mockSet = setConfigValue as unknown as Mock;

describe("heartbeat DB persistence", () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockSet.mockReset();
    existsSync.mockReset().mockReturnValue(false);
    readFileSync.mockReset().mockReturnValue("");
  });

  it("setHeartbeat writes to the DB config store", async () => {
    mockSet.mockResolvedValue(undefined);
    await setHeartbeat("## reply to urgent slack pings");
    expect(mockSet).toHaveBeenCalledWith("heartbeat.content", "## reply to urgent slack pings");
  });

  it("getHeartbeat returns the DB value when present (source of truth)", async () => {
    mockGet.mockResolvedValue("from db");
    expect(await getHeartbeat()).toBe("from db");
    expect(mockSet).not.toHaveBeenCalled();
  });

  it("migrates a HEARTBEAT.md file into the DB when the DB is empty", async () => {
    mockGet.mockResolvedValue(null);
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue("from file");
    mockSet.mockResolvedValue(undefined);
    expect(await getHeartbeat()).toBe("from file");
    expect(mockSet).toHaveBeenCalledWith("heartbeat.content", "from file");
  });

  it("returns null when neither the DB nor a file has content", async () => {
    mockGet.mockResolvedValue(null);
    existsSync.mockReturnValue(false);
    expect(await getHeartbeat()).toBeNull();
  });

  it("falls back to the file when the DB is unavailable", async () => {
    mockGet.mockRejectedValue(new Error("no db"));
    existsSync.mockReturnValue(true);
    readFileSync.mockReturnValue("from file");
    expect(await getHeartbeat()).toBe("from file");
  });
});
