import { describe, expect, it } from "vitest";
import { buildSystemPromptAppend, type UserProfile, type AgentIdentity } from "./profile.ts";

describe("buildSystemPromptAppend", () => {
  const defaultIdentity: AgentIdentity = { name: "Nomos" };

  it("includes memory instructions with empty profile", () => {
    const result = buildSystemPromptAppend({
      profile: {},
      identity: defaultIdentity,
    });

    expect(result).toContain("## Memory");
    expect(result).toContain("memory_search tool");
    expect(result).toContain("proactively search memory");
  });

  it("includes agent identity when name is not default", () => {
    const result = buildSystemPromptAppend({
      profile: {},
      identity: { name: "Jarvis" },
    });

    expect(result).toContain("Your name is Jarvis.");
  });

  it("does not include identity section for default name", () => {
    const result = buildSystemPromptAppend({
      profile: {},
      identity: defaultIdentity,
    });

    expect(result).not.toContain("Your name is");
  });

  it("includes user profile fields", () => {
    const profile: UserProfile = {
      name: "Alice",
      timezone: "America/New_York",
      workspace: "Building a React dashboard",
    };

    const result = buildSystemPromptAppend({
      profile,
      identity: defaultIdentity,
    });

    expect(result).toContain("## User Profile");
    expect(result).toContain("Alice");
    expect(result).toContain("America/New_York");
    expect(result).toContain("React dashboard");
  });

  it("includes custom instructions", () => {
    const profile: UserProfile = {
      instructions: "Always respond in Spanish.",
    };

    const result = buildSystemPromptAppend({
      profile,
      identity: defaultIdentity,
    });

    expect(result).toContain("## Custom Instructions");
    expect(result).toContain("Always respond in Spanish.");
  });

  it("includes skills prompt when provided", () => {
    const result = buildSystemPromptAppend({
      profile: {},
      identity: defaultIdentity,
      skillsPrompt: "## Skills\n### github\nUse gh CLI.",
    });

    expect(result).toContain("## Skills");
    expect(result).toContain("github");
  });

  it("does not include skills section when skillsPrompt is empty", () => {
    const result = buildSystemPromptAppend({
      profile: {},
      identity: defaultIdentity,
      skillsPrompt: undefined,
    });

    // Should only have Memory section
    expect(result).toContain("## Memory");
    expect(result).not.toContain("## Skills");
  });

  it("combines all sections", () => {
    const result = buildSystemPromptAppend({
      profile: {
        name: "Bob",
        timezone: "UTC",
        instructions: "Be concise.",
      },
      identity: { name: "Max", emoji: "🤖" },
      skillsPrompt: "## Skills\n### test\nA skill.",
    });

    expect(result).toContain("Your name is Max.");
    expect(result).toContain("Bob");
    expect(result).toContain("UTC");
    expect(result).toContain("## Custom Instructions");
    expect(result).toContain("Be concise.");
    expect(result).toContain("## Memory");
    expect(result).toContain("## Skills");
  });

  it("includes runtime info when provided", () => {
    const runtimeInfo =
      "OS: darwin\nArch: arm64\nShell: /bin/zsh\nNode: v20.10.0\nCWD: /home/user/project";
    const result = buildSystemPromptAppend({
      profile: {},
      identity: defaultIdentity,
      runtimeInfo,
    });

    expect(result).toContain("## Runtime Environment");
    expect(result).toContain("OS: darwin");
    expect(result).toContain("Arch: arm64");
    expect(result).toContain("Shell: /bin/zsh");
    expect(result).toContain("Node: v20.10.0");
    expect(result).toContain("CWD: /home/user/project");
  });

  it("does not include runtime section when runtimeInfo is not provided", () => {
    const result = buildSystemPromptAppend({
      profile: {},
      identity: defaultIdentity,
    });

    expect(result).not.toContain("## Runtime Environment");
  });

  it("includes purpose when set on identity", () => {
    const result = buildSystemPromptAppend({
      profile: {},
      identity: { name: "Coder", purpose: "Full-stack TypeScript coding assistant" },
    });

    expect(result).toContain("## Purpose");
    expect(result).toContain("Full-stack TypeScript coding assistant");
    expect(result).toContain("core role");
  });

  it("does not include purpose section when purpose is not set", () => {
    const result = buildSystemPromptAppend({
      profile: {},
      identity: defaultIdentity,
    });

    expect(result).not.toContain("## Purpose");
  });
});
