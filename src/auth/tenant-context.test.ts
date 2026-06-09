import { describe, it, expect, afterEach } from "vitest";
import { LOCAL_TENANT, resolveMemoryUserId, systemTenant } from "./tenant-context.ts";

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

describe("resolveMemoryUserId", () => {
  const originalMode = process.env.NOMOS_MODE;
  const originalOrg = process.env.NOMOS_ORG_ID;
  afterEach(() => {
    if (originalMode === undefined) delete process.env.NOMOS_MODE;
    else process.env.NOMOS_MODE = originalMode;
    if (originalOrg === undefined) delete process.env.NOMOS_ORG_ID;
    else process.env.NOMOS_ORG_ID = originalOrg;
  });

  it("collapses every channel id to 'local' in power-user mode", () => {
    delete process.env.NOMOS_MODE; // default = power_user
    // The fragmentation case: a Slack / iMessage / Telegram sender id must NOT
    // become its own partition. All channels are the single owner.
    expect(resolveMemoryUserId("U07ABC")).toBe("local");
    expect(resolveMemoryUserId("+15551234567")).toBe("local");
    expect(resolveMemoryUserId("local")).toBe("local");
    expect(resolveMemoryUserId(undefined)).toBe("local");
    expect(resolveMemoryUserId(null)).toBe("local");
    // Even synthetic ids collapse to local in power-user.
    expect(resolveMemoryUserId("cron-scheduler")).toBe("local");
    expect(resolveMemoryUserId("did:key:abc")).toBe("local");
  });

  it("explicit power_user mode also collapses to 'local'", () => {
    process.env.NOMOS_MODE = "power_user";
    expect(resolveMemoryUserId("U07ABC")).toBe("local");
  });

  it("keeps a real authenticated per-tenant id in hosted mode", () => {
    process.env.NOMOS_MODE = "hosted";
    process.env.NOMOS_ORG_ID = "org-1";
    expect(resolveMemoryUserId("user-42")).toBe("user-42");
    expect(resolveMemoryUserId("U07ABC")).toBe("U07ABC");
  });

  it("collapses synthetic/system ids onto the instance owner in hosted mode", () => {
    // cron scheduler, CATE remote DIDs, and the 'system' sentinel must never
    // mint their own per-id partition; they fold onto systemTenant().userId.
    process.env.NOMOS_MODE = "hosted";
    process.env.NOMOS_ORG_ID = "org-1";
    expect(resolveMemoryUserId("cron-scheduler")).toBe("system");
    expect(resolveMemoryUserId("system")).toBe("system");
    expect(resolveMemoryUserId("did:key:z6Mk...")).toBe("system");
    expect(resolveMemoryUserId(undefined)).toBe("system");
    expect(resolveMemoryUserId(null)).toBe("system");
  });

  it("hosted without NOMOS_ORG_ID resolves synthetic ids to 'local' (single owner)", () => {
    process.env.NOMOS_MODE = "hosted";
    delete process.env.NOMOS_ORG_ID; // systemTenant() => LOCAL_TENANT
    expect(resolveMemoryUserId("cron-scheduler")).toBe("local");
    expect(resolveMemoryUserId(undefined)).toBe("local");
  });
});
