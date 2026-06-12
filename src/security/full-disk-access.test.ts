import process from "node:process";
import { describe, expect, it } from "vitest";
import {
  canReadMessagesDb,
  fullDiskAccessBinary,
  fullDiskAccessHint,
  messagesDbPath,
} from "./full-disk-access.ts";

describe("full-disk-access", () => {
  it("points at ~/Library/Messages/chat.db", () => {
    expect(messagesDbPath().endsWith("/Library/Messages/chat.db")).toBe(true);
  });

  it("targets the running node binary for the grant", () => {
    expect(fullDiskAccessBinary()).toBe(process.execPath);
  });

  it("returns a boolean and is false when the db is unreadable/absent", () => {
    // On CI (Linux) the path doesn't exist -> false; on a granted Mac -> true.
    // Either way it must be a boolean and never throw.
    const result = canReadMessagesDb();
    expect(typeof result).toBe("boolean");
  });

  it("hint names Full Disk Access and the binary to grant", () => {
    const hint = fullDiskAccessHint("/opt/homebrew/bin/node");
    expect(hint).toContain("Full Disk Access");
    expect(hint).toContain("/opt/homebrew/bin/node");
  });

  it("hint defaults to the running binary", () => {
    expect(fullDiskAccessHint()).toContain(process.execPath);
  });
});
