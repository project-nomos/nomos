import { describe, expect, it } from "vitest";
import {
  buildSystemPromptAppend,
  type UserProfile,
  type AgentIdentity,
  type ExemplarEntry,
} from "./profile.ts";

describe("buildSystemPromptAppend", () => {
  const defaultIdentity: AgentIdentity = { name: "Nomos" };

  it("includes memory instructions with empty profile", () => {
    const result = buildSystemPromptAppend({
      profile: {},
      identity: defaultIdentity,
    });

    expect(result).toContain("## Memory");
    expect(result).toContain("memory_search");
    expect(result).toContain("user_model_recall");
  });

  it("includes agent identity when name is not default", () => {
    const result = buildSystemPromptAppend({
      profile: {},
      identity: { name: "Jarvis" },
    });

    expect(result).toContain("## Identity");
    expect(result).toContain("You are Jarvis");
  });

  it("includes identity section for default name", () => {
    const result = buildSystemPromptAppend({
      profile: {},
      identity: defaultIdentity,
    });

    expect(result).toContain("## Identity");
    expect(result).toContain("You are Nomos");
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

    expect(result).toContain("You are Max");
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

  it("includes decision patterns as 'How You Think' section", () => {
    const result = buildSystemPromptAppend({
      profile: {},
      identity: defaultIdentity,
      userModel: [
        {
          id: "1",
          category: "decision_pattern",
          key: "prefer_simplicity",
          value: {
            principle: "Choose the simpler solution unless complexity is justified",
            context: "architecture decisions",
            weight: 0.9,
            evidence: ["rejected microservices for a small project"],
            exceptions: ["high-scale systems"],
          },
          sourceIds: [],
          confidence: 0.8,
          updatedAt: new Date(),
        },
      ],
    });

    expect(result).toContain("## How You Think");
    expect(result).toContain("Choose the simpler solution");
    expect(result).toContain("architecture decisions");
    expect(result).toContain("high-scale systems");
  });

  it("includes values as 'Your Guiding Principles' section", () => {
    const result = buildSystemPromptAppend({
      profile: {},
      identity: defaultIdentity,
      userModel: [
        {
          id: "1",
          category: "value",
          key: "simplicity",
          value: {
            value: "Simplicity",
            description: "Prefer simple, readable solutions over clever ones",
          },
          sourceIds: [],
          confidence: 0.85,
          updatedAt: new Date(),
        },
      ],
    });

    expect(result).toContain("## Your Guiding Principles");
    expect(result).toContain("**Simplicity**");
    expect(result).toContain("Prefer simple, readable solutions");
  });

  it("separates decision patterns and values from standard user model", () => {
    const result = buildSystemPromptAppend({
      profile: {},
      identity: defaultIdentity,
      userModel: [
        {
          id: "1",
          category: "preference",
          key: "editor",
          value: "vscode",
          sourceIds: [],
          confidence: 0.7,
          updatedAt: new Date(),
        },
        {
          id: "2",
          category: "decision_pattern",
          key: "test_first",
          value: {
            principle: "Write tests before implementation",
            context: "coding",
            weight: 0.8,
            evidence: [],
            exceptions: [],
          },
          sourceIds: [],
          confidence: 0.75,
          updatedAt: new Date(),
        },
      ],
    });

    expect(result).toContain("## How You Think");
    expect(result).toContain("## What I Know About You");
    expect(result).toContain("editor");
    // decision_pattern should NOT appear in the "What I Know" section
    expect(result.indexOf("test_first")).toBeLessThan(result.indexOf("editor"));
  });

  it("includes exemplars as 'Voice Examples' section", () => {
    const exemplars: ExemplarEntry[] = [
      {
        text: "Hey team, let's keep this PR small and focused -- we can iterate after.",
        context: "slack_work",
        platform: "slack",
      },
    ];

    const result = buildSystemPromptAppend({
      profile: {},
      identity: defaultIdentity,
      exemplars,
    });

    expect(result).toContain("## Voice Examples");
    expect(result).toContain("let's keep this PR small");
    expect(result).toContain("[slack_work]");
  });

  it("does not include exemplars section when empty", () => {
    const result = buildSystemPromptAppend({
      profile: {},
      identity: defaultIdentity,
      exemplars: [],
    });

    expect(result).not.toContain("## Voice Examples");
  });

  it("includes user state section when provided", () => {
    const userState =
      "## Current User State\nFocus: deep | Emotion: neutral | Cognitive load: high | Urgency: none | Energy: normal\nAssessment: In deep focus mode. Dealing with complex topic\n\n**Response guidance:** Match the user's depth -- provide thorough, detailed responses";
    const result = buildSystemPromptAppend({
      profile: {},
      identity: defaultIdentity,
      userState,
    });

    expect(result).toContain("## Current User State");
    expect(result).toContain("Focus: deep");
    expect(result).toContain("Response guidance");
  });

  it("does not include user state section when not provided", () => {
    const result = buildSystemPromptAppend({
      profile: {},
      identity: defaultIdentity,
    });

    expect(result).not.toContain("## Current User State");
  });

  it("places user state before memory section", () => {
    const userState = "## Current User State\nFocus: normal";
    const result = buildSystemPromptAppend({
      profile: {},
      identity: defaultIdentity,
      userState,
    });

    const stateIdx = result.indexOf("## Current User State");
    const memoryIdx = result.indexOf("## Memory");
    expect(stateIdx).toBeLessThan(memoryIdx);
  });
});
