import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import process from "node:process";
import { config } from "dotenv";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureNomosEnvFile, envLoadOrder, isSourceRun } from "./env-bootstrap.ts";

describe("isSourceRun", () => {
  it("is true for a TypeScript source run (tsx / pnpm dev)", () => {
    expect(isSourceRun("file:///Users/me/nomos/src/index.ts")).toBe(true);
  });

  it("is false for the compiled, installed binary (dist/index.js)", () => {
    expect(isSourceRun("file:///opt/homebrew/Cellar/nomos/0.1.53/libexec/dist/index.js")).toBe(
      false,
    );
  });
});

describe("envLoadOrder", () => {
  it("installed binary loads ~/.nomos first so it wins over a stray CWD .env", () => {
    const order = envLoadOrder("/home/me/.nomos", false);
    expect(order[0]).toEqual(["/home/me/.nomos/.env.local", "/home/me/.nomos/.env"]);
    expect(order[1]).toEqual([".env.local", ".env"]);
  });

  it("source run keeps repo .env first for development", () => {
    const order = envLoadOrder("/home/me/.nomos", true);
    expect(order[0]).toEqual([".env.local", ".env"]);
    expect(order[1]).toEqual(["/home/me/.nomos/.env.local", "/home/me/.nomos/.env"]);
  });
});

describe("ensureNomosEnvFile", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(join(os.tmpdir(), "nomos-env-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("creates ~/.nomos/.env with a DATABASE_URL default when missing", () => {
    const nomosDir = join(dir, ".nomos");
    const envPath = ensureNomosEnvFile(nomosDir);

    expect(fs.existsSync(envPath)).toBe(true);
    const contents = fs.readFileSync(envPath, "utf8");
    expect(contents).toContain("DATABASE_URL=postgresql://localhost:5432/nomos");
  });

  it("never clobbers an existing file", () => {
    const nomosDir = join(dir, ".nomos");
    fs.mkdirSync(nomosDir, { recursive: true });
    const envPath = join(nomosDir, ".env");
    fs.writeFileSync(envPath, "DATABASE_URL=postgresql://custom@db/mine\n");

    ensureNomosEnvFile(nomosDir);

    expect(fs.readFileSync(envPath, "utf8")).toBe("DATABASE_URL=postgresql://custom@db/mine\n");
  });
});

// The regression: nomos run from a project dir whose .env has
// DATABASE_URL=postgresql://${USER}@... produced `role "${USER}" does not exist`,
// because the CWD .env was loaded first and dotenv applies the first value seen.
// With the installed load order, ~/.nomos/.env must win.
describe("installed-binary precedence (end-to-end via dotenv)", () => {
  let home: string;
  let cwd: string;
  let prevCwd: string;
  let prevDbUrl: string | undefined;

  beforeEach(() => {
    home = fs.mkdtempSync(join(os.tmpdir(), "nomos-home-"));
    cwd = fs.mkdtempSync(join(os.tmpdir(), "nomos-cwd-"));
    prevCwd = process.cwd();
    prevDbUrl = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
  });

  afterEach(() => {
    process.chdir(prevCwd);
    if (prevDbUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prevDbUrl;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("~/.nomos/.env DATABASE_URL beats a stray CWD .env (the literal ${USER} bug)", () => {
    const nomosDir = join(home, ".nomos");
    ensureNomosEnvFile(nomosDir);
    fs.writeFileSync(join(cwd, ".env"), "DATABASE_URL=postgresql://${USER}@localhost:5432/nomos\n");

    process.chdir(cwd);
    for (const paths of envLoadOrder(nomosDir, false)) {
      config({ path: paths, quiet: true });
    }

    expect(process.env.DATABASE_URL).toBe("postgresql://localhost:5432/nomos");
    expect(process.env.DATABASE_URL).not.toContain("${USER}");
  });
});
