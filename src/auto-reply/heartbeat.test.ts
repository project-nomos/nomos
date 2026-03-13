import { describe, it, expect } from "vitest";
import { isHeartbeatEmpty, stripHeartbeatToken, HEARTBEAT_OK, AUTONOMOUS_OK } from "./heartbeat.ts";

describe("isHeartbeatEmpty", () => {
  it("returns true for empty string", () => {
    expect(isHeartbeatEmpty("")).toBe(true);
  });

  it("returns true for whitespace only", () => {
    expect(isHeartbeatEmpty("   \n  \t  \n")).toBe(true);
  });

  it("returns true for comments only", () => {
    expect(isHeartbeatEmpty("<!-- comment -->\n// another comment")).toBe(true);
  });

  it("returns true for empty markdown headers", () => {
    expect(isHeartbeatEmpty("# \n## \n### ")).toBe(true);
  });

  it("returns true for mix of whitespace, comments, and empty headers", () => {
    expect(isHeartbeatEmpty("\n<!-- comment -->\n## \n  \n// line comment\n###  ")).toBe(true);
  });

  it("returns false for actual content", () => {
    expect(isHeartbeatEmpty("# Task\nDo something")).toBe(false);
  });

  it("returns false for header with content", () => {
    expect(isHeartbeatEmpty("# Important")).toBe(false);
  });

  it("returns false for single word", () => {
    expect(isHeartbeatEmpty("hello")).toBe(false);
  });

  it("returns false for content after comments", () => {
    expect(isHeartbeatEmpty("<!-- comment -->\nActual task here")).toBe(false);
  });
});

describe("stripHeartbeatToken", () => {
  it("returns null for plain HEARTBEAT_OK", () => {
    expect(stripHeartbeatToken(HEARTBEAT_OK)).toBe(null);
  });

  it("returns null for HEARTBEAT_OK with whitespace", () => {
    expect(stripHeartbeatToken("  HEARTBEAT_OK  \n")).toBe(null);
  });

  it("returns null for backtick-wrapped HEARTBEAT_OK", () => {
    expect(stripHeartbeatToken("`HEARTBEAT_OK`")).toBe(null);
  });

  it("returns null for bold-wrapped HEARTBEAT_OK", () => {
    expect(stripHeartbeatToken("**HEARTBEAT_OK**")).toBe(null);
  });

  it("returns null for italic-wrapped HEARTBEAT_OK", () => {
    expect(stripHeartbeatToken("_HEARTBEAT_OK_")).toBe(null);
  });

  it("returns null for multiple markdown wrappers", () => {
    expect(stripHeartbeatToken("***HEARTBEAT_OK***")).toBe(null);
  });

  it("returns null for code block wrapped HEARTBEAT_OK", () => {
    expect(stripHeartbeatToken("```\nHEARTBEAT_OK\n```")).toBe(null);
  });

  it("returns null for code block with language wrapped HEARTBEAT_OK", () => {
    expect(stripHeartbeatToken("```text\nHEARTBEAT_OK\n```")).toBe(null);
  });

  it("returns original text for normal response", () => {
    const text = "Here is my response";
    expect(stripHeartbeatToken(text)).toBe(text);
  });

  it("returns original text if HEARTBEAT_OK is part of larger message", () => {
    const text = "Everything is fine. HEARTBEAT_OK for now.";
    expect(stripHeartbeatToken(text)).toBe(text);
  });

  it("returns original text for HEARTBEAT_OK in middle of sentence", () => {
    const text = "The status is HEARTBEAT_OK right now";
    expect(stripHeartbeatToken(text)).toBe(text);
  });

  it("returns null for plain AUTONOMOUS_OK", () => {
    expect(stripHeartbeatToken(AUTONOMOUS_OK)).toBe(null);
  });

  it("returns null for AUTONOMOUS_OK with whitespace", () => {
    expect(stripHeartbeatToken("  AUTONOMOUS_OK  \n")).toBe(null);
  });

  it("returns null for backtick-wrapped AUTONOMOUS_OK", () => {
    expect(stripHeartbeatToken("`AUTONOMOUS_OK`")).toBe(null);
  });

  it("returns null for code block wrapped AUTONOMOUS_OK", () => {
    expect(stripHeartbeatToken("```\nAUTONOMOUS_OK\n```")).toBe(null);
  });

  it("returns original text if AUTONOMOUS_OK is part of larger message", () => {
    const text = "Check complete. AUTONOMOUS_OK for now.";
    expect(stripHeartbeatToken(text)).toBe(text);
  });
});
