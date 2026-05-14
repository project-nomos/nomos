import fs from "node:fs";
import path from "node:path";
import postgres from "postgres";

let sqlInstance: postgres.Sql | null = null;

/** Default to local Postgres with `nomos` db -- matches the daemon's default. */
const DEFAULT_DATABASE_URL = "postgresql://localhost:5432/nomos";

function loadDatabaseUrl(): string {
  // Try a few candidate .env paths (cwd, parent, grandparent).
  // In Homebrew installs the standalone server runs from
  // .next/standalone/<dir>/server.js so the project root is several levels up.
  const candidates = [
    path.resolve(process.cwd(), ".env"),
    path.resolve(process.cwd(), "..", ".env"),
    path.resolve(process.cwd(), "..", "..", ".env"),
    path.resolve(process.cwd(), "..", "..", "..", ".env"),
  ];
  for (const envPath of candidates) {
    if (!fs.existsSync(envPath)) continue;
    const content = fs.readFileSync(envPath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("#") || !trimmed.includes("=")) continue;
      const eqIdx = trimmed.indexOf("=");
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim();
      if (key === "DATABASE_URL") {
        return value;
      }
    }
  }
  // No .env found, no DATABASE_URL set -- fall through to local default.
  // The setup wizard can update this via the integrations table later.
  return DEFAULT_DATABASE_URL;
}

export function getDb(): postgres.Sql {
  if (!sqlInstance) {
    const url = process.env.DATABASE_URL || loadDatabaseUrl();
    sqlInstance = postgres(url, {
      max: 5,
      idle_timeout: 30,
      connect_timeout: 10,
      onnotice: () => {},
    });
  }
  return sqlInstance;
}
