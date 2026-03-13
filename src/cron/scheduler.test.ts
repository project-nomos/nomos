import { describe, expect, it } from "vitest";
import { parseInterval, nextCronRun } from "./scheduler.ts";

describe("parseInterval", () => {
  it("parses seconds", () => {
    expect(parseInterval("30s")).toBe(30_000);
  });

  it("parses minutes", () => {
    expect(parseInterval("5m")).toBe(5 * 60_000);
  });

  it("parses hours", () => {
    expect(parseInterval("2h")).toBe(2 * 60 * 60_000);
  });

  it("parses days", () => {
    expect(parseInterval("1d")).toBe(24 * 60 * 60_000);
  });

  it("throws on invalid format — missing unit", () => {
    expect(() => parseInterval("30")).toThrow("Invalid interval format");
  });

  it("throws on invalid format — unknown unit", () => {
    expect(() => parseInterval("30x")).toThrow("Invalid interval format");
  });

  it("throws on invalid format — empty string", () => {
    expect(() => parseInterval("")).toThrow("Invalid interval format");
  });

  it("throws on invalid format — letters only", () => {
    expect(() => parseInterval("abc")).toThrow("Invalid interval format");
  });
});

describe("nextCronRun", () => {
  it("returns a future Date for valid cron expression", () => {
    const result = nextCronRun("*/5 * * * *"); // every 5 minutes
    expect(result).toBeInstanceOf(Date);
    expect(result.getTime()).toBeGreaterThan(Date.now());
  });

  it("throws on invalid cron expression", () => {
    expect(() => nextCronRun("not a cron")).toThrow("Invalid cron expression");
  });

  it("handles standard cron expressions", () => {
    const result = nextCronRun("0 9 * * 1"); // 9 AM every Monday
    expect(result).toBeInstanceOf(Date);
    expect(result.getTime()).toBeGreaterThan(Date.now());
  });
});
