import { describe, it, expect } from "vitest";
import { isNewerVersion, getInstalledVersion } from "./version.ts";

describe("version", () => {
  describe("isNewerVersion", () => {
    it("returns true when latest major is higher", () => {
      expect(isNewerVersion("0.1.0", "1.0.0")).toBe(true);
    });

    it("returns true when latest minor is higher", () => {
      expect(isNewerVersion("0.1.0", "0.2.0")).toBe(true);
    });

    it("returns true when latest patch is higher", () => {
      expect(isNewerVersion("0.1.0", "0.1.2")).toBe(true);
    });

    it("returns false when versions are equal", () => {
      expect(isNewerVersion("0.1.0", "0.1.0")).toBe(false);
    });

    it("returns false when current is newer", () => {
      expect(isNewerVersion("1.0.0", "0.9.9")).toBe(false);
    });

    it("handles major version differences correctly", () => {
      expect(isNewerVersion("2.0.0", "1.9.9")).toBe(false);
    });
  });

  describe("getInstalledVersion", () => {
    it("returns a valid semver string", () => {
      const version = getInstalledVersion();
      expect(version).toMatch(/^\d+\.\d+\.\d+/);
    });
  });
});
