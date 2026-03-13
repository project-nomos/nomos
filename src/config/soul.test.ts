import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadSoulFile } from "./soul.ts";
import { buildSystemPromptAppend } from "./profile.ts";
import type { UserProfile, AgentIdentity } from "./profile.ts";

vi.mock("node:fs");
vi.mock("node:os");

describe("loadSoulFile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(os.homedir).mockReturnValue("/home/user");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns null when no SOUL.md file exists", () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const result = loadSoulFile();

    expect(result).toBeNull();
    expect(fs.existsSync).toHaveBeenCalledWith(path.resolve(".nomos", "SOUL.md"));
    expect(fs.existsSync).toHaveBeenCalledWith("/home/user/.nomos/SOUL.md");
  });

  it("returns content from project-local SOUL.md", () => {
    const soulContent = "Be friendly and helpful.";
    vi.mocked(fs.existsSync).mockImplementation((filePath) => {
      return filePath === path.resolve(".nomos", "SOUL.md");
    });
    vi.mocked(fs.readFileSync).mockReturnValue(soulContent);

    const result = loadSoulFile();

    expect(result).toBe(soulContent);
    expect(fs.readFileSync).toHaveBeenCalledWith(path.resolve(".nomos", "SOUL.md"), "utf-8");
  });

  it("returns content from global SOUL.md when project-local doesn't exist", () => {
    const soulContent = "Be concise and technical.";
    vi.mocked(fs.existsSync).mockImplementation((filePath) => {
      return filePath === "/home/user/.nomos/SOUL.md";
    });
    vi.mocked(fs.readFileSync).mockReturnValue(soulContent);

    const result = loadSoulFile();

    expect(result).toBe(soulContent);
    expect(fs.readFileSync).toHaveBeenCalledWith("/home/user/.nomos/SOUL.md", "utf-8");
  });

  it("prefers project-local over global SOUL.md", () => {
    const projectContent = "Project personality";
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockImplementation((filePath) => {
      if (filePath === path.resolve(".nomos", "SOUL.md")) {
        return projectContent;
      }
      return "Global personality";
    });

    const result = loadSoulFile();

    expect(result).toBe(projectContent);
    expect(fs.readFileSync).toHaveBeenCalledTimes(1);
  });

  it("returns null when file is unreadable", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error("Permission denied");
    });

    const result = loadSoulFile();

    expect(result).toBeNull();
  });
});

describe("buildSystemPromptAppend with soulPrompt", () => {
  const mockProfile: UserProfile = {
    name: "Alice",
    timezone: "America/New_York",
  };

  const mockIdentity: AgentIdentity = {
    name: "TestBot",
  };

  it("includes personality section when soulPrompt is provided", () => {
    const soulPrompt = "Be enthusiastic and use exclamation points!";
    const result = buildSystemPromptAppend({
      profile: mockProfile,
      identity: mockIdentity,
      soulPrompt,
    });

    expect(result).toContain("## Personality");
    expect(result).toContain(soulPrompt);
    expect(result).toContain("Embody this personality in all responses.");

    // Personality should come first (before identity)
    const personalityIndex = result.indexOf("## Personality");
    const identityIndex = result.indexOf("Your name is TestBot");
    expect(personalityIndex).toBeLessThan(identityIndex);
    expect(personalityIndex).toBeGreaterThanOrEqual(0);
    expect(identityIndex).toBeGreaterThan(0);
  });

  it("omits personality section when soulPrompt is not provided", () => {
    const result = buildSystemPromptAppend({
      profile: mockProfile,
      identity: mockIdentity,
    });

    expect(result).not.toContain("## Personality");
    expect(result).not.toContain("Embody this personality");
  });

  it("omits personality section when soulPrompt is undefined", () => {
    const result = buildSystemPromptAppend({
      profile: mockProfile,
      identity: mockIdentity,
      soulPrompt: undefined,
    });

    expect(result).not.toContain("## Personality");
  });

  it("includes all sections when soulPrompt, skillsPrompt, and runtimeInfo are provided", () => {
    const soulPrompt = "Be concise.";
    const skillsPrompt = "## Skills\nYou have git skill.";
    const runtimeInfo = "OS: linux\nArch: x64";

    const result = buildSystemPromptAppend({
      profile: mockProfile,
      identity: mockIdentity,
      soulPrompt,
      skillsPrompt,
      runtimeInfo,
    });

    expect(result).toContain("## Personality");
    expect(result).toContain(soulPrompt);
    expect(result).toContain("Your name is TestBot");
    expect(result).toContain("## User Profile");
    expect(result).toContain("Alice");
    expect(result).toContain("## Runtime Environment");
    expect(result).toContain(runtimeInfo);
    expect(result).toContain("## Memory");
    expect(result).toContain(skillsPrompt);
  });
});
