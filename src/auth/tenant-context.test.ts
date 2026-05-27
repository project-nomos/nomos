import { describe, it, expect, afterEach } from "vitest";
import { LOCAL_TENANT, systemTenant } from "./tenant-context.ts";

describe("tenant-context", () => {
  const original = process.env.NOMOS_ORG_ID;
  afterEach(() => {
    if (original === undefined) delete process.env.NOMOS_ORG_ID;
    else process.env.NOMOS_ORG_ID = original;
  });

  it("LOCAL_TENANT is the fallback singleton", () => {
    expect(LOCAL_TENANT.orgId).toBe("local");
    expect(LOCAL_TENANT.userId).toBe("local");
  });

  it("systemTenant() returns LOCAL_TENANT when NOMOS_ORG_ID unset", () => {
    delete process.env.NOMOS_ORG_ID;
    expect(systemTenant()).toEqual(LOCAL_TENANT);
  });

  it("systemTenant() reflects NOMOS_ORG_ID when hosted", () => {
    process.env.NOMOS_ORG_ID = "abc123";
    const ctx = systemTenant();
    expect(ctx.orgId).toBe("abc123");
    expect(ctx.userId).toBe("system");
  });
});
