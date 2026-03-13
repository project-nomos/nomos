import fs from "node:fs";
import path from "node:path";

function getEnvPath(): string {
  return path.resolve(process.cwd(), "..", ".env");
}

export function readEnv(): Record<string, string> {
  const envPath = getEnvPath();
  if (!fs.existsSync(envPath)) {
    return {};
  }
  const content = fs.readFileSync(envPath, "utf-8");
  const result: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const eqIdx = trimmed.indexOf("=");
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    result[key] = value;
  }
  return result;
}

export function writeEnv(updates: Record<string, string>): void {
  const envPath = getEnvPath();
  let content = "";
  if (fs.existsSync(envPath)) {
    content = fs.readFileSync(envPath, "utf-8");
  }

  const lines = content.split("\n");
  const updatedKeys = new Set<string>();

  const newLines = lines.map((line) => {
    const trimmed = line.trim();
    // Also match commented-out lines like "# KEY=" so we can uncomment them
    const commentMatch = trimmed.match(/^#\s*([A-Z_][A-Z0-9_]*)=/);
    if (commentMatch) {
      const key = commentMatch[1];
      if (key in updates) {
        updatedKeys.add(key);
        if (updates[key] === "") {
          return `# ${key}=`;
        }
        return `${key}=${updates[key]}`;
      }
      return line;
    }
    if (trimmed.startsWith("#") || !trimmed.includes("=")) return line;
    const eqIdx = trimmed.indexOf("=");
    const key = trimmed.slice(0, eqIdx).trim();
    if (key in updates) {
      updatedKeys.add(key);
      if (updates[key] === "") {
        return `# ${key}=`;
      }
      return `${key}=${updates[key]}`;
    }
    return line;
  });

  // Append keys that weren't already in the file
  for (const [key, value] of Object.entries(updates)) {
    if (!updatedKeys.has(key)) {
      if (value !== "") {
        newLines.push(`${key}=${value}`);
      }
    }
  }

  fs.writeFileSync(envPath, newLines.join("\n"));
}

export function maskToken(token: string): string {
  if (!token || token.length <= 8) return token ? "***" : "";
  return token.slice(0, 8) + "***";
}
