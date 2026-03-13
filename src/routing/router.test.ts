import { describe, expect, it } from "vitest";
import { AgentRouter, type RouteContext } from "./router.ts";
import type { RouteRule } from "./types.ts";

function makeRule(overrides: Partial<RouteRule> & { id: string }): RouteRule {
  return {
    priority: 0,
    match: {},
    target: { agentId: "default" },
    enabled: true,
    ...overrides,
  };
}

function makeContext(overrides?: Partial<RouteContext>): RouteContext {
  return {
    platform: "slack",
    channelId: "C123",
    userId: "U456",
    ...overrides,
  };
}

describe("AgentRouter", () => {
  it("returns null when there are no rules", () => {
    const router = new AgentRouter([]);
    expect(router.resolve(makeContext())).toBeNull();
  });

  it("returns null when no rules match", () => {
    const router = new AgentRouter([makeRule({ id: "r1", match: { platform: "discord" } })]);
    expect(router.resolve(makeContext({ platform: "slack" }))).toBeNull();
  });

  it("matches a rule by platform", () => {
    const target = { agentId: "slack-agent" };
    const router = new AgentRouter([makeRule({ id: "r1", match: { platform: "slack" }, target })]);
    expect(router.resolve(makeContext())).toEqual(target);
  });

  it("matches a rule by channelId", () => {
    const target = { agentId: "channel-agent" };
    const router = new AgentRouter([makeRule({ id: "r1", match: { channelId: "C123" }, target })]);
    expect(router.resolve(makeContext())).toEqual(target);
  });

  it("matches a rule by guildId", () => {
    const target = { agentId: "guild-agent" };
    const router = new AgentRouter([makeRule({ id: "r1", match: { guildId: "G789" }, target })]);
    expect(router.resolve(makeContext({ guildId: "G789" }))).toEqual(target);
  });

  it("matches a rule by teamId", () => {
    const target = { agentId: "team-agent" };
    const router = new AgentRouter([makeRule({ id: "r1", match: { teamId: "T100" }, target })]);
    expect(router.resolve(makeContext({ teamId: "T100" }))).toEqual(target);
  });

  it("matches a rule by userId", () => {
    const target = { agentId: "user-agent" };
    const router = new AgentRouter([makeRule({ id: "r1", match: { userId: "U456" }, target })]);
    expect(router.resolve(makeContext())).toEqual(target);
  });

  it("respects priority ordering (higher priority first)", () => {
    const lowTarget = { agentId: "low" };
    const highTarget = { agentId: "high" };
    const router = new AgentRouter([
      makeRule({ id: "low", priority: 1, match: { platform: "slack" }, target: lowTarget }),
      makeRule({ id: "high", priority: 10, match: { platform: "slack" }, target: highTarget }),
    ]);
    expect(router.resolve(makeContext())).toEqual(highTarget);
  });

  it("skips disabled rules", () => {
    const router = new AgentRouter([
      makeRule({
        id: "r1",
        match: { platform: "slack" },
        target: { agentId: "disabled-agent" },
        enabled: false,
      }),
    ]);
    expect(router.resolve(makeContext())).toBeNull();
  });

  it("matches regex pattern against messageText", () => {
    const target = { agentId: "pattern-agent" };
    const router = new AgentRouter([makeRule({ id: "r1", match: { pattern: "^hello" }, target })]);
    expect(router.resolve(makeContext({ messageText: "hello world" }))).toEqual(target);
    expect(router.resolve(makeContext({ messageText: "say hello" }))).toBeNull();
  });

  it("returns null for pattern match when no messageText provided", () => {
    const router = new AgentRouter([
      makeRule({ id: "r1", match: { pattern: "hello" }, target: { agentId: "x" } }),
    ]);
    expect(router.resolve(makeContext())).toBeNull();
  });

  it("treats invalid regex as no match", () => {
    const router = new AgentRouter([
      makeRule({ id: "r1", match: { pattern: "[invalid" }, target: { agentId: "x" } }),
    ]);
    expect(router.resolve(makeContext({ messageText: "anything" }))).toBeNull();
  });

  it("uses AND logic — all specified fields must match", () => {
    const target = { agentId: "specific-agent" };
    const router = new AgentRouter([
      makeRule({
        id: "r1",
        match: { platform: "slack", channelId: "C123", userId: "U456" },
        target,
      }),
    ]);

    // All match
    expect(router.resolve(makeContext())).toEqual(target);

    // Platform mismatch
    expect(router.resolve(makeContext({ platform: "discord" }))).toBeNull();

    // Channel mismatch
    expect(router.resolve(makeContext({ channelId: "C999" }))).toBeNull();

    // User mismatch
    expect(router.resolve(makeContext({ userId: "U999" }))).toBeNull();
  });

  it("returns false for role match (not yet implemented)", () => {
    const router = new AgentRouter([
      makeRule({ id: "r1", match: { role: "admin" }, target: { agentId: "admin-agent" } }),
    ]);
    expect(router.resolve(makeContext())).toBeNull();
  });

  describe("addRule", () => {
    it("adds a rule and re-sorts by priority", () => {
      const router = new AgentRouter([
        makeRule({ id: "r1", priority: 5, match: { platform: "slack" }, target: { agentId: "a" } }),
      ]);

      router.addRule(
        makeRule({
          id: "r2",
          priority: 10,
          match: { platform: "slack" },
          target: { agentId: "b" },
        }),
      );

      // Higher priority rule should match first
      expect(router.resolve(makeContext())?.agentId).toBe("b");
    });
  });

  describe("removeRule", () => {
    it("removes a rule by id", () => {
      const router = new AgentRouter([
        makeRule({
          id: "r1",
          match: { platform: "slack" },
          target: { agentId: "a" },
        }),
      ]);

      router.removeRule("r1");
      expect(router.resolve(makeContext())).toBeNull();
    });
  });

  describe("listRules", () => {
    it("returns a copy of all rules sorted by priority", () => {
      const rules = [
        makeRule({ id: "r1", priority: 1 }),
        makeRule({ id: "r2", priority: 10 }),
        makeRule({ id: "r3", priority: 5 }),
      ];
      const router = new AgentRouter(rules);
      const listed = router.listRules();

      expect(listed).toHaveLength(3);
      expect(listed[0].id).toBe("r2");
      expect(listed[1].id).toBe("r3");
      expect(listed[2].id).toBe("r1");

      // Should be a copy
      listed.pop();
      expect(router.listRules()).toHaveLength(3);
    });
  });
});
