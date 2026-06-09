import { describe, it, expect } from "vitest";
import { SessionStore } from "./store.ts";
import type { ScopeMode, SessionScope } from "./types.ts";

// buildKey is private; reach it via a typed cast. It is the single source of
// truth for session-key shape per scope mode.
const key = (mode: ScopeMode, scope: SessionScope): string =>
  (new SessionStore(mode) as unknown as { buildKey(s: SessionScope): string }).buildKey(scope);

const P = "slack";
const C = "C123";
const U1 = "U1";
const U2 = "U2";

describe("SessionStore scope modes", () => {
  it("defaults to channel scope", () => {
    expect(key("channel", { platform: P, channelId: C })).toBe(
      (new SessionStore() as unknown as { buildKey(s: SessionScope): string }).buildKey({
        platform: P,
        channelId: C,
      }),
    );
  });

  it("channel: one key per channel; users in a channel share it", () => {
    expect(key("channel", { platform: P, channelId: C })).toBe("slack:C123");
    expect(key("channel", { platform: P, channelId: C, userId: U1 })).toBe(
      key("channel", { platform: P, channelId: C, userId: U2 }),
    );
  });

  it("sender: one key per user per channel; users are separated", () => {
    expect(key("sender", { platform: P, channelId: C, userId: U1 })).toBe("slack:C123:U1");
    expect(key("sender", { platform: P, channelId: C, userId: U1 })).not.toBe(
      key("sender", { platform: P, channelId: C, userId: U2 }),
    );
  });

  it("peer: one key per user globally; channelId ignored", () => {
    expect(key("peer", { platform: P, userId: U1 })).toBe("slack:U1");
    expect(key("peer", { platform: P, userId: U1, channelId: C })).toBe("slack:U1");
    expect(key("peer", { platform: P, userId: U1 })).not.toBe(
      key("peer", { platform: P, userId: U2 }),
    );
  });

  it("channel-peer: same shape as sender, users separated", () => {
    expect(key("channel-peer", { platform: P, channelId: C, userId: U1 })).toBe("slack:C123:U1");
    expect(key("channel-peer", { platform: P, channelId: C, userId: U1 })).toBe(
      key("sender", { platform: P, channelId: C, userId: U1 }),
    );
    expect(key("channel-peer", { platform: P, channelId: C, userId: U1 })).not.toBe(
      key("channel-peer", { platform: P, channelId: C, userId: U2 }),
    );
  });

  it("throws on missing required fields per mode", () => {
    expect(() => key("channel", { platform: P })).toThrow(/channelId is required/);
    expect(() => key("sender", { platform: P, channelId: C })).toThrow(
      /channelId and userId are required/,
    );
    expect(() => key("peer", { platform: P })).toThrow(/userId is required/);
    expect(() => key("channel-peer", { platform: P, userId: U1 })).toThrow(
      /channelId and userId are required/,
    );
  });
});
