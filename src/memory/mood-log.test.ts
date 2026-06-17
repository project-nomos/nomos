import { beforeEach, describe, expect, it, vi } from "vitest";

const { vaultRead, vaultWrite } = vi.hoisted(() => ({ vaultRead: vi.fn(), vaultWrite: vi.fn() }));
const { loadEnvConfig } = vi.hoisted(() => ({ loadEnvConfig: vi.fn() }));
const { runForkedAgent } = vi.hoisted(() => ({ runForkedAgent: vi.fn() }));

vi.mock("./vault.ts", () => ({ vaultRead, vaultWrite }));
vi.mock("../config/env.ts", () => ({ loadEnvConfig }));
vi.mock("../sdk/forked-agent.ts", () => ({ runForkedAgent }));

import {
  parseMoodCapture,
  parseMoodLog,
  readOpenMoodEpisodes,
  recordMoodEpisode,
} from "./mood-log.ts";

const DAY = 86_400_000;

describe("parseMoodLog", () => {
  it("parses ` · `-delimited episode lines", () => {
    const eps = parseMoodLog("- 2026-06-10 · stressed · Q3 launch · open\n- 2026-06-01 · frustrated · the migration · resolved");
    expect(eps).toHaveLength(2);
    expect(eps[0]).toEqual({ date: "2026-06-10", emotion: "stressed", cause: "Q3 launch", status: "open" });
    expect(eps[1].status).toBe("resolved");
  });
});

describe("parseMoodCapture", () => {
  it("returns the episode on real strain", () => {
    expect(parseMoodCapture('{"strain":true,"emotion":"stressed","cause":"Q3 launch"}')).toEqual({
      emotion: "stressed",
      cause: "Q3 launch",
    });
  });
  it("returns null when there's no strain or it's unparseable", () => {
    expect(parseMoodCapture('{"strain":false}')).toBeNull();
    expect(parseMoodCapture("nope")).toBeNull();
  });
  it("recovers JSON wrapped in prose/fences", () => {
    expect(parseMoodCapture('```json\n{"strain":true,"emotion":"anxious","cause":"the review"}\n```')?.cause).toBe(
      "the review",
    );
  });
});

describe("recordMoodEpisode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadEnvConfig.mockReturnValue({ adaptiveMemory: true });
    vaultRead.mockResolvedValue(null);
  });

  it("writes a new episode to mood-log.md", async () => {
    await recordMoodEpisode("u1", "stressed", "Q3 launch", { nowMs: Date.parse("2026-06-17") });
    expect(vaultWrite).toHaveBeenCalledWith(
      "u1",
      "mood-log.md",
      expect.stringContaining("2026-06-17 · stressed · Q3 launch · open"),
      expect.anything(),
    );
  });

  it("updates the existing episode for the same cause (no duplicate)", async () => {
    vaultRead.mockResolvedValue({ content: "- 2026-06-10 · frustrated · Q3 launch · open" });
    await recordMoodEpisode("u1", "stressed", "q3 LAUNCH", { nowMs: Date.parse("2026-06-17") });
    const written = vaultWrite.mock.calls[0][2] as string;
    expect(parseMoodLog(written).filter((e) => /q3 launch/i.test(e.cause))).toHaveLength(1);
    expect(written).toContain("2026-06-17 · stressed");
  });

  it("is a no-op when adaptive memory is off", async () => {
    loadEnvConfig.mockReturnValue({ adaptiveMemory: false });
    await recordMoodEpisode("u1", "stressed", "x");
    expect(vaultWrite).not.toHaveBeenCalled();
  });
});

describe("readOpenMoodEpisodes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadEnvConfig.mockReturnValue({ adaptiveMemory: true });
  });

  it("returns open episodes and decays stale ones", async () => {
    const now = Date.parse("2026-06-17");
    vaultRead.mockResolvedValue({
      content: [
        `- 2026-06-16 · stressed · launch · open`, // recent, open
        `- 2026-06-15 · frustrated · bug · resolved`, // resolved → excluded
        `- ${new Date(now - 60 * DAY).toISOString().slice(0, 10)} · anxious · old thing · open`, // stale → decayed
      ].join("\n"),
    });
    const open = await readOpenMoodEpisodes("u1", now);
    expect(open.map((e) => e.cause)).toEqual(["launch"]);
  });
});
