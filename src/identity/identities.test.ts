import { describe, it, expect } from "vitest";
import { contactFieldsFromMetadata } from "./identities.ts";

describe("contactFieldsFromMetadata", () => {
  it("maps a channel job title to a role", () => {
    expect(contactFieldsFromMetadata({ title: "Engineering Manager" })).toEqual({
      role: "Engineering Manager",
    });
  });

  it("prefers an explicit role over a job title", () => {
    expect(contactFieldsFromMetadata({ role: "friend", title: "CFO" }).role).toBe("friend");
  });

  it("captures company when present", () => {
    expect(contactFieldsFromMetadata({ company: "Acme" }).company).toBe("Acme");
  });

  it("ignores empty/whitespace values and missing metadata", () => {
    expect(contactFieldsFromMetadata({ title: "   ", role: "" })).toEqual({});
    expect(contactFieldsFromMetadata(undefined)).toEqual({});
  });
});
