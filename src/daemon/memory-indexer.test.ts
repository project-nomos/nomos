import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../identity/identities.ts", () => ({ resolveContact: vi.fn() }));

import { resolveContact } from "../identity/identities.ts";
import {
  isEphemeralSession,
  resolveInboundIdentity,
  EXTERNAL_PLATFORMS,
} from "./memory-indexer.ts";
import type { IncomingMessage } from "./types.ts";

const mockResolve = resolveContact as unknown as ReturnType<typeof vi.fn>;

describe("isEphemeralSession", () => {
  it("matches an ephemeral segment anywhere in the session key", () => {
    expect(isEphemeralSession("mobile:ephemeral:abc123")).toBe(true);
    expect(isEphemeralSession("ephemeral:abc123")).toBe(true);
    expect(isEphemeralSession("cli:ephemeral")).toBe(true);
    expect(isEphemeralSession("ephemeral")).toBe(true);
  });

  it("does not match normal session keys", () => {
    expect(isEphemeralSession("cli:default")).toBe(false);
    expect(isEphemeralSession("slack:C0123")).toBe(false);
    expect(isEphemeralSession("mobile:user-42")).toBe(false);
  });

  it("does not match substrings that merely contain the word", () => {
    // guards on segment boundaries, not raw substring, so this is NOT ephemeral
    expect(isEphemeralSession("slack:ephemerally-named-channel")).toBe(false);
    expect(isEphemeralSession("discord:semiephemeral")).toBe(false);
  });
});

describe("resolveInboundIdentity", () => {
  beforeEach(() => mockResolve.mockReset());

  const msg = (over: Partial<IncomingMessage>): IncomingMessage => ({
    id: "m1",
    platform: "telegram",
    channelId: "c1",
    userId: "U_SENDER",
    content: "hi",
    timestamp: new Date(0),
    ...over,
  });

  it("resolves the sender with the display name + the adapter profile as metadata", async () => {
    await resolveInboundIdentity(
      msg({ metadata: { senderName: "Dana Ext", avatar: "a.png" } }),
      "local",
    );
    expect(mockResolve).toHaveBeenCalledWith(
      "local",
      "telegram",
      "U_SENDER",
      "Dana Ext",
      undefined,
      {
        senderName: "Dana Ext",
        avatar: "a.png",
      },
    );
  });

  it("resolves with no name + empty metadata when the adapter carries none (e.g. slack)", async () => {
    await resolveInboundIdentity(msg({ platform: "slack", metadata: undefined }), "local");
    expect(mockResolve).toHaveBeenCalledWith(
      "local",
      "slack",
      "U_SENDER",
      undefined,
      undefined,
      {},
    );
  });

  it("only treats real external platforms as contact-bearing", () => {
    expect(EXTERNAL_PLATFORMS.has("slack")).toBe(true);
    expect(EXTERNAL_PLATFORMS.has("discord")).toBe(true);
    expect(EXTERNAL_PLATFORMS.has("terminal")).toBe(false);
    expect(EXTERNAL_PLATFORMS.has("cli")).toBe(false);
    expect(EXTERNAL_PLATFORMS.has("cron")).toBe(false);
  });
});
