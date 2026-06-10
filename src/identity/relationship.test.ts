import { describe, it, expect } from "vitest";
import { buildInboundRelationship, frequencyFromStats } from "./relationship.ts";

describe("frequencyFromStats", () => {
  const day = 24 * 60 * 60 * 1000;
  const span = (days: number) => ({
    first: new Date(0).toISOString(),
    last: new Date(days * day).toISOString(),
  });

  it("is 'rare' without a date range", () => {
    expect(frequencyFromStats(100, null, null)).toBe("rare");
  });

  it("buckets by messages-per-day", () => {
    const { first, last } = span(10);
    expect(frequencyFromStats(30, first, last)).toBe("daily"); // 3/day
    expect(frequencyFromStats(5, first, last)).toBe("weekly"); // 0.5/day
    expect(frequencyFromStats(1, first, last)).toBe("monthly"); // 0.1/day
    expect(frequencyFromStats(0, first, last)).toBe("rare"); // 0/day
  });
});

describe("buildInboundRelationship", () => {
  const now = "2026-06-09T00:00:00.000Z";

  it("stamps firstContact + messageCount=1 on the first touch", () => {
    const r = buildInboundRelationship({ created: true, priorMessageCount: 0, nowIso: now });
    expect(r.firstContact).toBe(now);
    expect(r.lastContact).toBe(now);
    expect(r.messageCount).toBe(1);
  });

  it("bumps the message count and omits firstContact on later touches", () => {
    const r = buildInboundRelationship({ created: false, priorMessageCount: 4, nowIso: now });
    expect(r.firstContact).toBeUndefined();
    expect(r.lastContact).toBe(now);
    expect(r.messageCount).toBe(5);
  });

  it("folds in role + company when known, omits them otherwise", () => {
    const withRole = buildInboundRelationship({
      created: true,
      priorMessageCount: 0,
      nowIso: now,
      role: "Engineering Manager",
      company: "Acme",
    });
    expect(withRole.role).toBe("Engineering Manager");
    expect(withRole.company).toBe("Acme");

    const bare = buildInboundRelationship({ created: true, priorMessageCount: 0, nowIso: now });
    expect("role" in bare).toBe(false);
    expect("company" in bare).toBe(false);
  });
});
