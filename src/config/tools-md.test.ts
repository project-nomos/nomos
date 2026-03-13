import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadToolsFile } from "./tools-md.ts";
import { buildSystemPromptAppend } from "./profile.ts";
import type { UserProfile, AgentIdentity } from "./profile.ts";

vi.mock("node:fs");
vi.mock("node:os");

describe("loadToolsFile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(os.homedir).mockReturnValue("/home/user");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns null when no TOOLS.md file exists", () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    const result = loadToolsFile();

    expect(result).toBeNull();
    expect(fs.existsSync).toHaveBeenCalledWith(path.resolve(".nomos", "TOOLS.md"));
    expect(fs.existsSync).toHaveBeenCalledWith("/home/user/.nomos/TOOLS.md");
  });

  it("returns content from project-local TOOLS.md", () => {
    const toolsContent = "API_HOST=https://api.example.com\nSSH_HOST=prod-server-01";
    vi.mocked(fs.existsSync).mockImplementation((filePath) => {
      return filePath === path.resolve(".nomos", "TOOLS.md");
    });
    vi.mocked(fs.readFileSync).mockReturnValue(toolsContent);

    const result = loadToolsFile();

    expect(result).toBe(toolsContent);
    expect(fs.readFileSync).toHaveBeenCalledWith(path.resolve(".nomos", "TOOLS.md"), "utf-8");
  });

  it("returns content from global TOOLS.md when project-local doesn't exist", () => {
    const toolsContent = "DEFAULT_SSH=bastion.example.com";
    vi.mocked(fs.existsSync).mockImplementation((filePath) => {
      return filePath === "/home/user/.nomos/TOOLS.md";
    });
    vi.mocked(fs.readFileSync).mockReturnValue(toolsContent);

    const result = loadToolsFile();

    expect(result).toBe(toolsContent);
    expect(fs.readFileSync).toHaveBeenCalledWith("/home/user/.nomos/TOOLS.md", "utf-8");
  });

  it("prefers project-local over global TOOLS.md", () => {
    const projectContent = "PROJECT_API=https://staging.example.com";
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockImplementation((filePath) => {
      if (filePath === path.resolve(".nomos", "TOOLS.md")) {
        return projectContent;
      }
      return "GLOBAL_API=https://prod.example.com";
    });

    const result = loadToolsFile();

    expect(result).toBe(projectContent);
    expect(fs.readFileSync).toHaveBeenCalledTimes(1);
  });

  it("returns null when file is unreadable", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error("Permission denied");
    });

    const result = loadToolsFile();

    expect(result).toBeNull();
  });
});

describe("buildSystemPromptAppend with toolsPrompt", () => {
  const mockProfile: UserProfile = {
    name: "Alice",
    timezone: "America/New_York",
  };

  const mockIdentity: AgentIdentity = {
    name: "TestBot",
  };

  it("includes environment configuration section when toolsPrompt is provided", () => {
    const toolsPrompt = "SSH_HOST=prod-server-01\nAPI_ENDPOINT=https://api.example.com";
    const result = buildSystemPromptAppend({
      profile: mockProfile,
      identity: mockIdentity,
      toolsPrompt,
    });

    expect(result).toContain("## Environment Configuration");
    expect(result).toContain(toolsPrompt);

    // Tools section should come after personality (if present) but before identity
    const identityIndex = result.indexOf("Your name is TestBot");
    const toolsIndex = result.indexOf("## Environment Configuration");
    expect(toolsIndex).toBeLessThan(identityIndex);
    expect(toolsIndex).toBeGreaterThanOrEqual(0);
    expect(identityIndex).toBeGreaterThan(0);
  });

  it("omits environment configuration section when toolsPrompt is not provided", () => {
    const result = buildSystemPromptAppend({
      profile: mockProfile,
      identity: mockIdentity,
    });

    expect(result).not.toContain("## Environment Configuration");
  });

  it("omits environment configuration section when toolsPrompt is undefined", () => {
    const result = buildSystemPromptAppend({
      profile: mockProfile,
      identity: mockIdentity,
      toolsPrompt: undefined,
    });

    expect(result).not.toContain("## Environment Configuration");
  });

  it("places toolsPrompt after soulPrompt but before identity", () => {
    const soulPrompt = "Be enthusiastic!";
    const toolsPrompt = "API_HOST=https://api.example.com";

    const result = buildSystemPromptAppend({
      profile: mockProfile,
      identity: mockIdentity,
      soulPrompt,
      toolsPrompt,
    });

    const personalityIndex = result.indexOf("## Personality");
    const toolsIndex = result.indexOf("## Environment Configuration");
    const identityIndex = result.indexOf("Your name is TestBot");

    expect(personalityIndex).toBeLessThan(toolsIndex);
    expect(toolsIndex).toBeLessThan(identityIndex);
    expect(personalityIndex).toBeGreaterThanOrEqual(0);
    expect(toolsIndex).toBeGreaterThan(0);
    expect(identityIndex).toBeGreaterThan(0);
  });

  it("includes all sections when soulPrompt, toolsPrompt, skillsPrompt, and runtimeInfo are provided", () => {
    const soulPrompt = "Be concise.";
    const toolsPrompt = "SSH_HOST=prod-server";
    const skillsPrompt = "## Skills\nYou have git skill.";
    const runtimeInfo = "OS: linux\nArch: x64";

    const result = buildSystemPromptAppend({
      profile: mockProfile,
      identity: mockIdentity,
      soulPrompt,
      toolsPrompt,
      skillsPrompt,
      runtimeInfo,
    });

    expect(result).toContain("## Personality");
    expect(result).toContain(soulPrompt);
    expect(result).toContain("## Environment Configuration");
    expect(result).toContain(toolsPrompt);
    expect(result).toContain("Your name is TestBot");
    expect(result).toContain("## User Profile");
    expect(result).toContain("Alice");
    expect(result).toContain("## Runtime Environment");
    expect(result).toContain(runtimeInfo);
    expect(result).toContain("## Memory");
    expect(result).toContain(skillsPrompt);
  });
});
