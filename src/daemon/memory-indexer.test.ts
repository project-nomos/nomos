import { describe, it, expect } from "vitest";
import { isEphemeralSession } from "./memory-indexer.ts";

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
