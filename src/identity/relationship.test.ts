import { describe, it, expect } from "vitest";
import { buildInboundRelationship } from "./relationship.ts";

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
