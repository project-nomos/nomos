import { describe, expect, it, vi, beforeEach } from "vitest";
import { getBootstrapPrompt } from "./bootstrap.ts";
import type { AgentIdentity } from "../config/profile.ts";

// Mock the DB config module
vi.mock("../db/config.js", () => {
  let store: Record<string, unknown> = {};
  return {
    getConfigValue: vi.fn((key: string) => store[key] ?? null),
    setConfigValue: vi.fn((key: string, value: unknown) => {
      store[key] = value;
    }),
    _reset: () => {
      store = {};
    },
  };
});

describe("bootstrap", () => {
  beforeEach(async () => {
    const mod = (await import("../db/config.ts")) as unknown as { _reset: () => void };
    mod._reset();
  });

  describe("shouldBootstrap", () => {
    it("returns true when user.name is not set", async () => {
      const { shouldBootstrap } = await import("./bootstrap.ts");
      expect(await shouldBootstrap()).toBe(true);
    });

    it("returns false when user.name is set", async () => {
      const { setConfigValue } = await import("../db/config.ts");
      await setConfigValue("user.name", "Alice");
      const { shouldBootstrap } = await import("./bootstrap.ts");
      expect(await shouldBootstrap()).toBe(false);
    });
  });

  describe("getBootstrapPrompt", () => {
    it("returns a prompt with the identity name and purpose discovery", () => {
      const identity: AgentIdentity = { name: "Jarvis" };
      const prompt = getBootstrapPrompt(identity);
      expect(prompt).toContain("Jarvis");
      expect(prompt).toContain("bootstrap_complete");
      expect(prompt).toContain("purpose");
      expect(prompt).toContain("first time");
    });

    it("includes the default name when identity is default", () => {
      const identity: AgentIdentity = { name: "Nomos" };
      const prompt = getBootstrapPrompt(identity);
      expect(prompt).toContain("Nomos");
    });
  });

  describe("handleBootstrapComplete", () => {
    it("persists required and optional fields", async () => {
      const { handleBootstrapComplete } = await import("./bootstrap.ts");
      const { getConfigValue } = await import("../db/config.ts");

      await handleBootstrapComplete({
        purpose: "Full-stack TypeScript coding assistant",
        user_name: "Alice",
        workspace: "Building a CLI tool",
        instructions: "Be concise",
        agent_name: "Jarvis",
        agent_emoji: "🤖",
      });

      expect(await getConfigValue("agent.purpose")).toBe("Full-stack TypeScript coding assistant");
      expect(await getConfigValue("user.name")).toBe("Alice");
      expect(await getConfigValue("user.workspace")).toBe("Building a CLI tool");
      expect(await getConfigValue("user.instructions")).toBe("Be concise");
      expect(await getConfigValue("agent.name")).toBe("Jarvis");
      expect(await getConfigValue("agent.emoji")).toBe("🤖");
    });

    it("only persists required fields when optionals are omitted", async () => {
      const { handleBootstrapComplete } = await import("./bootstrap.ts");
      const { getConfigValue } = await import("../db/config.ts");

      await handleBootstrapComplete({
        purpose: "General coding assistant",
        user_name: "Bob",
      });

      expect(await getConfigValue("agent.purpose")).toBe("General coding assistant");
      expect(await getConfigValue("user.name")).toBe("Bob");
      expect(await getConfigValue("user.workspace")).toBeNull();
      expect(await getConfigValue("agent.name")).toBeNull();
    });
  });
});
