import { describe, it, expect } from "vitest";
import { isValidSchemaName, assertValidSchemaName } from "./migrator.ts";

describe("isValidSchemaName", () => {
  it("accepts well-formed names", () => {
    expect(isValidSchemaName("nomos_abc123")).toBe(true);
    expect(isValidSchemaName("nomos_a")).toBe(true);
    expect(isValidSchemaName("nomos_user_42")).toBe(true);
    expect(isValidSchemaName("nomos_" + "a".repeat(48))).toBe(true);
  });

  it("rejects missing prefix", () => {
    expect(isValidSchemaName("public")).toBe(false);
    expect(isValidSchemaName("abc123")).toBe(false);
    expect(isValidSchemaName("customer_42")).toBe(false);
  });

  it("rejects uppercase and special chars (SQL injection vectors)", () => {
    expect(isValidSchemaName("nomos_ABC")).toBe(false);
    expect(isValidSchemaName("nomos_abc;DROP")).toBe(false);
    expect(isValidSchemaName("nomos_abc'")).toBe(false);
    expect(isValidSchemaName("nomos_abc-def")).toBe(false);
    expect(isValidSchemaName("nomos_abc def")).toBe(false);
  });

  it("rejects empty/over-long suffix", () => {
    expect(isValidSchemaName("nomos_")).toBe(false);
    expect(isValidSchemaName("nomos_" + "a".repeat(49))).toBe(false);
  });

  it("rejects reserved names", () => {
    expect(isValidSchemaName("nomos_admin")).toBe(false);
    expect(isValidSchemaName("nomos_system")).toBe(false);
    expect(isValidSchemaName("nomos_meta")).toBe(false);
  });
});

describe("assertValidSchemaName", () => {
  it("throws on invalid names", () => {
    expect(() => assertValidSchemaName("DROP TABLE users;")).toThrow();
    expect(() => assertValidSchemaName("nomos_admin")).toThrow();
    expect(() => assertValidSchemaName("public")).toThrow();
  });

  it("no-ops on valid names", () => {
    expect(() => assertValidSchemaName("nomos_abc")).not.toThrow();
  });
});
