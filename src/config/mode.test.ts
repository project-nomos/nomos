import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getMode, isHosted, FEATURES } from "./mode.ts";

describe("getMode", () => {
  const original = process.env.NOMOS_MODE;
  afterEach(() => {
    if (original === undefined) delete process.env.NOMOS_MODE;
    else process.env.NOMOS_MODE = original;
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
  beforeEach(() => {
    delete process.env.NOMOS_MODE;
  });
  afterEach(() => {
    if (original !== undefined) process.env.NOMOS_MODE = original;
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
