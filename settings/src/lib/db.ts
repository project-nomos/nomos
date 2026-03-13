import fs from "node:fs";
import path from "node:path";
import postgres from "postgres";

let sqlInstance: postgres.Sql | null = null;

function loadDatabaseUrl(): string {
  const envPath = path.resolve(process.cwd(), "..", ".env");
  if (!fs.existsSync(envPath)) {
    throw new Error(`No .env file found at ${envPath}`);
  }
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
  throw new Error("DATABASE_URL not found in parent .env file");
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
