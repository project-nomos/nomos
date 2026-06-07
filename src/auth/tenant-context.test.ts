import { describe, it, expect, afterEach } from "vitest";
import { LOCAL_TENANT, resolveVaultUserId, systemTenant } from "./tenant-context.ts";

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

describe("resolveVaultUserId", () => {
  const originalMode = process.env.NOMOS_MODE;
  afterEach(() => {
    if (originalMode === undefined) delete process.env.NOMOS_MODE;
    else process.env.NOMOS_MODE = originalMode;
  });

  it("collapses every channel id to 'local' in power-user mode", () => {
    delete process.env.NOMOS_MODE; // default = power_user
    // The fragmentation case: a Slack / iMessage / Telegram sender id must NOT
    // become its own vault. All channels are the single owner.
    expect(resolveVaultUserId("U07ABC")).toBe("local");
    expect(resolveVaultUserId("+15551234567")).toBe("local");
    expect(resolveVaultUserId("local")).toBe("local");
    expect(resolveVaultUserId(undefined)).toBe("local");
    expect(resolveVaultUserId(null)).toBe("local");
  });

  it("explicit power_user mode also collapses to 'local'", () => {
    process.env.NOMOS_MODE = "power_user";
    expect(resolveVaultUserId("U07ABC")).toBe("local");
  });

  it("keeps the authenticated per-tenant id in hosted mode", () => {
    process.env.NOMOS_MODE = "hosted";
    expect(resolveVaultUserId("user-42")).toBe("user-42");
    expect(resolveVaultUserId("U07ABC")).toBe("U07ABC");
  });

  it("falls back to 'local' in hosted mode only when no id is present", () => {
    process.env.NOMOS_MODE = "hosted";
    expect(resolveVaultUserId(undefined)).toBe("local");
    expect(resolveVaultUserId(null)).toBe("local");
  });
});
