import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";

const GITHUB_REPO = "project-nomos/nomos";

function getInstalledVersion(): string {
  try {
    // Walk up from settings/ to find root package.json
    let dir = process.cwd();
    for (let i = 0; i < 5; i++) {
      const pkgPath = path.join(dir, "package.json");
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
        if (pkg.name === "@project-nomos/nomos") {
          return pkg.version ?? "0.0.0";
        }
      }
      dir = path.dirname(dir);
    }
  } catch {
    // fall through
  }
  return "0.0.0";
}

export async function GET() {
  const current = getInstalledVersion();

  let latest: string | null = null;
  try {
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(5000),
      next: { revalidate: 3600 }, // Cache for 1 hour
    });
    if (res.ok) {
      const data = await res.json();
      latest = (data.tag_name ?? "").replace(/^v/, "") || null;
    }
  } catch {
    // Offline or rate-limited
  }

  let updateAvailable = false;
  if (latest) {
    const parse = (v: string) => v.split(".").map((n: string) => parseInt(n, 10) || 0);
    const [cMaj, cMin, cPat] = parse(current);
    const [lMaj, lMin, lPat] = parse(latest);
    updateAvailable =
      lMaj > cMaj || (lMaj === cMaj && (lMin > cMin || (lMin === cMin && lPat > cPat)));
  }

  return NextResponse.json({ current, latest, updateAvailable });
}
