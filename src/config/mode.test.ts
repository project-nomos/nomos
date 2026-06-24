import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getMode, isHosted, FEATURES } from "./mode.ts";

describe("getMode", () => {
  const original = process.env.NOMOS_MODE;
  const originalJwks = process.env.AUTH_JWKS_URL;
  beforeEach(() => {
    delete process.env.AUTH_JWKS_URL; // these cases isolate NOMOS_MODE
  });
  afterEach(() => {
    if (original === undefined) delete process.env.NOMOS_MODE;
    else process.env.NOMOS_MODE = original;
    if (originalJwks === undefined) delete process.env.AUTH_JWKS_URL;
    else process.env.AUTH_JWKS_URL = originalJwks;
  });

  it("defaults to power_user when unset", () => {
    delete process.env.NOMOS_MODE;
    expect(getMode()).toBe("power_user");
    expect(isHosted()).toBe(false);
  });

  it("recognizes hosted", () => {
    process.env.NOMOS_MODE = "hosted";
    expect(getMode()).toBe("hosted");
    expect(isHosted()).toBe(true);
  });

  it("is case-insensitive and trims whitespace", () => {
    process.env.NOMOS_MODE = "  HOSTED  ";
    expect(getMode()).toBe("hosted");
  });

  it("treats unknown values as power_user (fail-open for safety in dev)", () => {
    process.env.NOMOS_MODE = "consumer"; // legacy name should not silently flip the gate on
    expect(getMode()).toBe("power_user");
  });

  it("treats AUTH_JWKS_URL as hosted even when NOMOS_MODE is unset (auth active = hosted)", () => {
    // The cross-user-leak guard: if JWT auth is configured, the gRPC interceptor
    // resolves real per-tenant ids, so the vault scoping must also see hosted,
    // otherwise every authenticated user collapses onto the 'local' vault.
    delete process.env.NOMOS_MODE;
    process.env.AUTH_JWKS_URL = "https://auth.example/jwks.json";
    expect(getMode()).toBe("hosted");
    expect(isHosted()).toBe(true);
  });
});

describe("FEATURES gates in hosted mode", () => {
  const original = process.env.NOMOS_MODE;
  beforeEach(() => {
    process.env.NOMOS_MODE = "hosted";
  });
  afterEach(() => {
    if (original === undefined) delete process.env.NOMOS_MODE;
    else process.env.NOMOS_MODE = original;
  });

  it("blocks BYO features", () => {
    expect(FEATURES.byoMcp()).toBe(false);
    expect(FEATURES.byoPlugins()).toBe(false);
    expect(FEATURES.byoChannelTokens()).toBe(false);
    expect(FEATURES.byoSkills()).toBe(false);
    expect(FEATURES.bashTool()).toBe(false);
    expect(FEATURES.iMessageChannel()).toBe(false);
    expect(FEATURES.setupWizard()).toBe(false);
  });

  it("keeps core features on", () => {
    expect(FEATURES.autoDream()).toBe(true);
    expect(FEATURES.magicDocs()).toBe(true);
    expect(FEATURES.teamMode()).toBe(true);
    expect(FEATURES.memory()).toBe(true);
    expect(FEATURES.skills()).toBe(true);
    expect(FEATURES.smartRouting()).toBe(true);
  });
});

describe("FEATURES gates in power-user mode", () => {
  const original = process.env.NOMOS_MODE;
  const originalJwks = process.env.AUTH_JWKS_URL;
  beforeEach(() => {
    delete process.env.NOMOS_MODE;
    delete process.env.AUTH_JWKS_URL; // else AUTH_JWKS_URL would imply hosted
  });
  afterEach(() => {
    if (original !== undefined) process.env.NOMOS_MODE = original;
    if (originalJwks === undefined) delete process.env.AUTH_JWKS_URL;
    else process.env.AUTH_JWKS_URL = originalJwks;
  });

  it("allows everything", () => {
    expect(FEATURES.byoMcp()).toBe(true);
    expect(FEATURES.byoPlugins()).toBe(true);
    expect(FEATURES.bashTool()).toBe(true);
    expect(FEATURES.iMessageChannel()).toBe(true);
    expect(FEATURES.setupWizard()).toBe(true);
    expect(FEATURES.autoDream()).toBe(true);
  });
});

describe("FEATURES.classroom (opt-in, off by default in both modes)", () => {
  const original = process.env.NOMOS_CLASSROOM;
  afterEach(() => {
    if (original === undefined) delete process.env.NOMOS_CLASSROOM;
    else process.env.NOMOS_CLASSROOM = original;
  });

  it("is off by default", () => {
    delete process.env.NOMOS_CLASSROOM;
    expect(FEATURES.classroom()).toBe(false);
  });

  it("is on when NOMOS_CLASSROOM=true", () => {
    process.env.NOMOS_CLASSROOM = "true";
    expect(FEATURES.classroom()).toBe(true);
  });

  it("treats any other value as off", () => {
    process.env.NOMOS_CLASSROOM = "1";
    expect(FEATURES.classroom()).toBe(false);
  });
});
