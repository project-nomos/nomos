/**
 * Settings-side mirror of the multi-account gws helper in
 * `src/auth/gws-accounts.ts` (main package). The two files implement the
 * same on-disk contract — `~/.config/gws/accounts.json` + per-account
 * subdirs — so the Settings UI and the daemon agree on layout.
 *
 * Kept duplicated because the Settings UI is a separate Next.js package
 * and we don't share TypeScript modules across the boundary.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface AccountManifestEntry {
  email: string;
  addedAt: string;
  isDefault: boolean;
}

export interface AccountManifest {
  version: 1;
  accounts: AccountManifestEntry[];
}

export function gwsRootDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg ? path.join(xdg, "gws") : path.join(os.homedir(), ".config", "gws");
}

export function accountDir(email: string): string {
  return path.join(gwsRootDir(), email);
}

export function manifestPath(): string {
  return path.join(gwsRootDir(), "accounts.json");
}

export function readManifest(): AccountManifest {
  const p = manifestPath();
  if (!fs.existsSync(p)) return { version: 1, accounts: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8")) as Partial<AccountManifest>;
    if (raw && raw.version === 1 && Array.isArray(raw.accounts)) {
      return raw as AccountManifest;
    }
  } catch {
    // ignore corrupt manifest
  }
  return { version: 1, accounts: [] };
}

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

export function addAccountToManifest(email: string, opts?: { makeDefault?: boolean }): void {
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

export function removeAccountFromManifest(email: string): void {
  const manifest = readManifest();
  const wasDefault = manifest.accounts.find((a) => a.email === email)?.isDefault ?? false;
  manifest.accounts = manifest.accounts.filter((a) => a.email !== email);
  if (wasDefault && manifest.accounts.length > 0) {
    manifest.accounts[0].isDefault = true;
  }
  writeManifest(manifest);

  const dir = accountDir(email);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

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

/** Path to a pending (pre-rename) auth working dir. */
export function pendingAuthDir(token: string): string {
  return path.join(gwsRootDir(), `.pending-${token}`);
}

/** Generate a short random token for pending auth dirs. */
export function newPendingToken(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

/** Write client_secret.json into an arbitrary directory (per-account or pending). */
export function writeClientSecretToDir(
  dir: string,
  params: { clientId: string; clientSecret: string; projectId: string },
): string {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, "client_secret.json");
  const data = {
    installed: {
      client_id: params.clientId,
      client_secret: params.clientSecret,
      project_id: params.projectId || "google-workspace-cli",
      auth_uri: "https://accounts.google.com/o/oauth2/auth",
      token_uri: "https://oauth2.googleapis.com/token",
      redirect_uris: ["http://localhost"],
    },
  };
  fs.writeFileSync(dest, JSON.stringify(data, null, 2), { mode: 0o600 });
  return dest;
}

/**
 * Promote a pending auth dir to a final per-account dir. Moves the
 * directory contents and registers the email in the manifest. If a dir
 * already exists for this email (re-auth), the pending dir replaces it.
 */
export function promotePendingDir(token: string, email: string): string {
  const src = pendingAuthDir(token);
  const dest = accountDir(email);

  if (!fs.existsSync(src)) {
    throw new Error(`Pending dir missing: ${src}`);
  }

  if (fs.existsSync(dest)) {
    fs.rmSync(dest, { recursive: true, force: true });
  }
  fs.renameSync(src, dest);

  addAccountToManifest(email);
  return dest;
}

export function cleanupPendingDir(token: string): void {
  const p = pendingAuthDir(token);
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}
