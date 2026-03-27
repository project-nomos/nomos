import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const GITHUB_REPO = "project-nomos/nomos";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

let cachedLatest: { version: string; checkedAt: number } | null = null;

/**
 * Read installed version from package.json.
 */
export function getInstalledVersion(): string {
  try {
    let dir = path.dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 5; i++) {
      const pkgPath = path.join(dir, "package.json");
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
        return pkg.version ?? "0.0.0";
      }
      dir = path.dirname(dir);
    }
  } catch {
    // fall through
  }
  return "0.0.0";
}

/**
 * Fetch the latest release version from GitHub (cached for 6 hours).
 * Returns null if the check fails (offline, rate-limited, etc.).
 */
export async function getLatestVersion(): Promise<string | null> {
  if (cachedLatest && Date.now() - cachedLatest.checkedAt < CACHE_TTL_MS) {
    return cachedLatest.version;
  }

  try {
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;

    const data = (await res.json()) as { tag_name?: string };
    const tag = data.tag_name ?? "";
    const version = tag.replace(/^v+/, "");
    if (!version) return null;

    cachedLatest = { version, checkedAt: Date.now() };
    return version;
  } catch {
    return null;
  }
}

/**
 * Compare two semver strings. Returns true if latest > current.
 */
export function isNewerVersion(current: string, latest: string): boolean {
  const parse = (v: string) => v.split(".").map((n) => parseInt(n, 10) || 0);
  const [cMajor, cMinor, cPatch] = parse(current);
  const [lMajor, lMinor, lPatch] = parse(latest);

  if (lMajor !== cMajor) return lMajor > cMajor;
  if (lMinor !== cMinor) return lMinor > cMinor;
  return lPatch > cPatch;
}

/**
 * Check if an upgrade is available. Non-blocking, swallows errors.
 * Returns upgrade info or null if up-to-date / check failed.
 */
export async function checkForUpgrade(): Promise<{
  current: string;
  latest: string;
} | null> {
  try {
    const current = getInstalledVersion();
    const latest = await getLatestVersion();
    if (latest && isNewerVersion(current, latest)) {
      return { current, latest };
    }
  } catch {
    // Never block the user
  }
  return null;
}
