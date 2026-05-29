import { describe, it, expect } from "vitest";
import { isValidDatabaseName, assertValidDatabaseName, withDatabaseName } from "./migrator.ts";

describe("isValidDatabaseName", () => {
  it("accepts well-formed names", () => {
    expect(isValidDatabaseName("nomos_abc123")).toBe(true);
    expect(isValidDatabaseName("nomos_a")).toBe(true);
    expect(isValidDatabaseName("nomos_user_42")).toBe(true);
    expect(isValidDatabaseName("nomos_" + "a".repeat(48))).toBe(true);
  });

  it("rejects missing prefix", () => {
    expect(isValidDatabaseName("public")).toBe(false);
    expect(isValidDatabaseName("abc123")).toBe(false);
    expect(isValidDatabaseName("customer_42")).toBe(false);
  });

  it("rejects uppercase and special chars (SQL injection vectors)", () => {
    expect(isValidDatabaseName("nomos_ABC")).toBe(false);
    expect(isValidDatabaseName("nomos_abc;DROP")).toBe(false);
    expect(isValidDatabaseName("nomos_abc'")).toBe(false);
    expect(isValidDatabaseName("nomos_abc-def")).toBe(false);
    expect(isValidDatabaseName("nomos_abc def")).toBe(false);
  });

  it("rejects empty/over-long suffix", () => {
    expect(isValidDatabaseName("nomos_")).toBe(false);
    expect(isValidDatabaseName("nomos_" + "a".repeat(49))).toBe(false);
  });

  it("rejects reserved names (including the admin server's own db)", () => {
    expect(isValidDatabaseName("nomos_server")).toBe(false);
    expect(isValidDatabaseName("nomos_admin")).toBe(false);
    expect(isValidDatabaseName("nomos_system")).toBe(false);
    expect(isValidDatabaseName("nomos_meta")).toBe(false);
  });
});

describe("assertValidDatabaseName", () => {
  it("throws on invalid names", () => {
    expect(() => assertValidDatabaseName("DROP DATABASE postgres;")).toThrow();
    expect(() => assertValidDatabaseName("nomos_server")).toThrow();
    expect(() => assertValidDatabaseName("public")).toThrow();
  });

  it("no-ops on valid names", () => {
    expect(() => assertValidDatabaseName("nomos_abc")).not.toThrow();
  });
});

describe("withDatabaseName", () => {
  it("swaps the database name in a connection URL", () => {
    expect(withDatabaseName("postgresql://u:p@host:5432/postgres", "nomos_abc")).toBe(
      "postgresql://u:p@host:5432/nomos_abc",
    );
    expect(withDatabaseName("postgresql://localhost:5432/nomos_server", "nomos_x9")).toBe(
      "postgresql://localhost:5432/nomos_x9",
    );
  });

  it("rejects an invalid target database name", () => {
    expect(() => withDatabaseName("postgresql://localhost/postgres", "x; DROP")).toThrow();
  });
});
