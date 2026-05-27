/**
 * Multi-account helper for the Google Workspace CLI (`gws`).
 *
 * Implements the convention from
 * https://github.com/indentcorp/gws-multi-account (see
 * https://github.com/googleworkspace/cli/issues/78 for upstream context):
 *
 *   ~/.config/gws/
 *   ├── accounts.json           — manifest: which emails are authorized
 *   ├── personal@gmail.com/
 *   │   ├── client_secret.json
 *   │   ├── credentials.enc
 *   │   └── token_cache.json
 *   └── work@company.com/
 *       └── ... (same shape)
 *
 * Every gws invocation must prepend
 * `GOOGLE_WORKSPACE_CLI_CONFIG_DIR=~/.config/gws/<email>` so it picks the
 * right account; the gws CLI itself is single-account so the env var is
 * the entire multi-account mechanism.
 *
 * The DB (`google_accounts` via `src/db/google-accounts.ts`) is a cache of
 * this manifest, used for sync to other surfaces (Settings UI, system
 * prompt). The on-disk manifest is the source of truth.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { promisify } from "node:util";
import { createLogger } from "../lib/logger.ts";

const execFileAsync = promisify(execFile);
const log = createLogger("gws-accounts");

/** Manifest entry on disk. */
export interface AccountManifestEntry {
  email: string;
  /** ISO timestamp of when this account was first authorized. */
  addedAt: string;
  /** Whether this is the default account when no email is specified. */
  isDefault: boolean;
}

export interface AccountManifest {
  version: 1;
  accounts: AccountManifestEntry[];
}

/** Root directory holding per-account subdirs. Honors XDG_CONFIG_HOME. */
export function gwsRootDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg ? path.join(xdg, "gws") : path.join(os.homedir(), ".config", "gws");
}

/** Per-account config directory. */
export function accountDir(email: string): string {
  return path.join(gwsRootDir(), email);
}

/** Path to the multi-account manifest. */
export function manifestPath(): string {
  return path.join(gwsRootDir(), "accounts.json");
}

/** Read the on-disk manifest. Returns an empty manifest if absent or corrupt. */
export function readManifest(): AccountManifest {
  const p = manifestPath();
  if (!fs.existsSync(p)) {
    return { version: 1, accounts: [] };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8")) as Partial<AccountManifest>;
    if (raw && raw.version === 1 && Array.isArray(raw.accounts)) {
      return raw as AccountManifest;
    }
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : err }, "Manifest corrupt; ignoring");
  }
  return { version: 1, accounts: [] };
}

/** Atomically write the manifest (temp file + rename). */
export function writeManifest(manifest: AccountManifest): void {
  const root = gwsRootDir();
  if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });
  const p = manifestPath();
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2), "utf8");
  fs.renameSync(tmp, p);
}

export function listAccounts(): AccountManifestEntry[] {
  return readManifest().accounts;
}

export function getDefaultAccount(): AccountManifestEntry | null {
  const accounts = listAccounts();
  return accounts.find((a) => a.isDefault) ?? accounts[0] ?? null;
}

export function getAccount(email: string): AccountManifestEntry | null {
  return listAccounts().find((a) => a.email === email) ?? null;
}

/**
 * Register an account in the manifest. Creates the per-account dir if
 * absent. If this is the first account it becomes default automatically.
 */
export function addAccount(email: string, opts?: { makeDefault?: boolean }): void {
  const dir = accountDir(email);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const manifest = readManifest();
  const existing = manifest.accounts.find((a) => a.email === email);
  const makeDefault = opts?.makeDefault ?? manifest.accounts.length === 0;

  if (makeDefault) {
    for (const a of manifest.accounts) a.isDefault = false;
  }

  if (existing) {
    if (makeDefault) existing.isDefault = true;
  } else {
    manifest.accounts.push({
      email,
      addedAt: new Date().toISOString(),
      isDefault: makeDefault,
    });
  }

  writeManifest(manifest);
}

/**
 * Remove an account from the manifest and delete its config directory.
 * If the removed account was default, promote the first remaining one.
 */
export function removeAccount(email: string): void {
  const manifest = readManifest();
  const wasDefault = manifest.accounts.find((a) => a.email === email)?.isDefault ?? false;
  manifest.accounts = manifest.accounts.filter((a) => a.email !== email);
  if (wasDefault && manifest.accounts.length > 0) {
    manifest.accounts[0].isDefault = true;
  }
  writeManifest(manifest);

  const dir = accountDir(email);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Mark the given account as default; demote all others. */
export function setDefaultAccount(email: string): void {
  const manifest = readManifest();
  let found = false;
  for (const a of manifest.accounts) {
    if (a.email === email) {
      a.isDefault = true;
      found = true;
    } else {
      a.isDefault = false;
    }
  }
  if (!found) throw new Error(`Account not in manifest: ${email}`);
  writeManifest(manifest);
}

/**
 * Copy a fresh client_secret.json into an account's config dir.
 * Required before running `gws auth login` for that account.
 */
export function writeClientSecret(
  email: string,
  payload: {
    clientId: string;
    clientSecret: string;
    projectId: string;
    redirectUris?: string[];
  },
): void {
  const dir = accountDir(email);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  // Standard Google "installed" OAuth client schema.
  const content = {
    installed: {
      client_id: payload.clientId,
      client_secret: payload.clientSecret,
      project_id: payload.projectId,
      auth_uri: "https://accounts.google.com/o/oauth2/auth",
      token_uri: "https://oauth2.googleapis.com/token",
      auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
      redirect_uris: payload.redirectUris ?? ["http://localhost"],
    },
  };

  fs.writeFileSync(path.join(dir, "client_secret.json"), JSON.stringify(content, null, 2), "utf8");
}

/** Environment additions to make `gws` operate on the given account. */
export function envForAccount(email: string): Record<string, string> {
  return { GOOGLE_WORKSPACE_CLI_CONFIG_DIR: accountDir(email) };
}

export interface RunGwsOptions {
  timeoutMs?: number;
  /** Extra env on top of the account env. */
  env?: Record<string, string | undefined>;
}

export interface RunGwsResult {
  stdout: string;
  stderr: string;
}

/**
 * Run a `gws` command scoped to the given account. Throws on non-zero exit
 * with stderr captured in the error message.
 */
export async function runGws(
  email: string,
  args: string[],
  options: RunGwsOptions = {},
): Promise<RunGwsResult> {
  const acct = getAccount(email);
  if (!acct) throw new Error(`Unknown Google account: ${email}`);

  const env = {
    ...process.env,
    ...envForAccount(email),
    ...(options.env ?? {}),
  };

  try {
    const { stdout, stderr } = await execFileAsync("npx", ["@googleworkspace/cli", ...args], {
      timeout: options.timeoutMs ?? 30_000,
      env: env as NodeJS.ProcessEnv,
      maxBuffer: 50 * 1024 * 1024,
    });
    return { stdout, stderr };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`gws call failed (${email}): ${message}`);
  }
}

/**
 * Run a `gws` command and parse the JSON output. The CLI sometimes prefixes
 * with a "Using keyring backend: ..." line, so we slice from the first `{` or `[`.
 */
export async function runGwsJson<T = unknown>(
  email: string,
  args: string[],
  options: RunGwsOptions = {},
): Promise<T> {
  const { stdout } = await runGws(email, args, options);
  const jsonStart = stdout.search(/[\[{]/);
  if (jsonStart < 0) {
    throw new Error(`gws ${args.join(" ")} returned no JSON output`);
  }
  return JSON.parse(stdout.slice(jsonStart)) as T;
}
