import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { envHasDatabaseUrl, shouldRunWizard } from "./wizard.ts";

describe("envHasDatabaseUrl", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(join(os.tmpdir(), "nomos-wiz-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("is false when the file does not exist", () => {
    expect(envHasDatabaseUrl(join(dir, ".env"))).toBe(false);
  });

  it("is true when DATABASE_URL has a value", () => {
    const p = join(dir, ".env");
    fs.writeFileSync(p, "FOO=bar\nDATABASE_URL=postgresql://localhost:5432/nomos\n");
    expect(envHasDatabaseUrl(p)).toBe(true);
  });

  it("is false for an empty assignment or a comment", () => {
    const p = join(dir, ".env");
    fs.writeFileSync(p, "# DATABASE_URL=postgresql://localhost/x\nDATABASE_URL=\n");
    expect(envHasDatabaseUrl(p)).toBe(false);
  });
});

describe("shouldRunWizard", () => {
  const prevMode = process.env.NOMOS_MODE;
  const prevJwks = process.env.AUTH_JWKS_URL;
  let cwd: string;
  let homeNomos: string;

  beforeEach(() => {
    process.env.NOMOS_MODE = "power_user"; // wizard is only active outside hosted mode
    delete process.env.AUTH_JWKS_URL;
    cwd = fs.mkdtempSync(join(os.tmpdir(), "nomos-cwd-"));
    homeNomos = join(fs.mkdtempSync(join(os.tmpdir(), "nomos-home-")), ".nomos", ".env");
  });
  afterEach(() => {
    if (prevMode === undefined) delete process.env.NOMOS_MODE;
    else process.env.NOMOS_MODE = prevMode;
    if (prevJwks === undefined) delete process.env.AUTH_JWKS_URL;
    else process.env.AUTH_JWKS_URL = prevJwks;
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("runs the wizard when neither the CWD .env nor ~/.nomos/.env is configured", () => {
    expect(shouldRunWizard({ cwd, nomosEnv: homeNomos })).toBe(true);
  });

  it("skips the wizard when the CWD .env has a DATABASE_URL", () => {
    fs.writeFileSync(join(cwd, ".env"), "DATABASE_URL=postgresql://localhost:5432/nomos\n");
    expect(shouldRunWizard({ cwd, nomosEnv: homeNomos })).toBe(false);
  });

  // The fix: the installed binary keeps config in ~/.nomos/.env. Running
  // `nomos chat` from a directory with no .env must NOT re-trigger setup.
  it("skips the wizard when only ~/.nomos/.env is configured", () => {
    fs.mkdirSync(join(homeNomos, ".."), { recursive: true });
    fs.writeFileSync(homeNomos, "DATABASE_URL=postgresql://localhost:5432/nomos\n");
    expect(shouldRunWizard({ cwd, nomosEnv: homeNomos })).toBe(false);
  });

  it("never runs the wizard in hosted mode", () => {
    process.env.NOMOS_MODE = "hosted";
    expect(shouldRunWizard({ cwd, nomosEnv: homeNomos })).toBe(false);
  });
});
