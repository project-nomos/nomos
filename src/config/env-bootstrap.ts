import fs from "node:fs";
import { join } from "node:path";

// Keep in sync with the fallbacks in src/db/client.ts and src/config/env.ts.
const DEFAULT_DATABASE_URL = "postgresql://localhost:5432/nomos";

const NOMOS_ENV_TEMPLATE = `# Nomos configuration (auto-created on first run).
#
# The installed \`nomos\` binary loads THIS file with precedence over any .env in
# your current working directory, so running nomos from another project's folder
# can't hijack its settings (e.g. a stray DATABASE_URL=postgresql://\${USER}@...).
# Edit values here, or via the Settings UI / \`nomos config\`.
DATABASE_URL=${DEFAULT_DATABASE_URL}
`;

/**
 * Are we running from TypeScript source (i.e. via tsx in development) rather
 * than the compiled, installed binary? The build emits dist/index.js, so the
 * running module URL ends in `.js` for an installed/Homebrew binary and `.ts`
 * when a developer runs `pnpm dev`. Mirrors the check in src/cli/start.ts.
 */
export function isSourceRun(moduleUrl: string): boolean {
  return moduleUrl.endsWith(".ts");
}

/**
 * Ensure ~/.nomos/.env exists. The installed binary treats this file as the
 * owner of its config, so on a fresh install we materialize it with a sane
 * local default. Writing DATABASE_URL here (rather than leaving the file empty)
 * is what actually shields the connection: it occupies the slot so a stray CWD
 * .env can't fill it. Never clobbers an existing file. Returns its path.
 */
export function ensureNomosEnvFile(nomosDir: string): string {
  const envPath = join(nomosDir, ".env");
  if (!fs.existsSync(envPath)) {
    fs.mkdirSync(nomosDir, { recursive: true });
    fs.writeFileSync(envPath, NOMOS_ENV_TEMPLATE, { mode: 0o600 });
  }
  return envPath;
}

/**
 * The order in which to feed files to dotenv. dotenv applies the FIRST value it
 * sees for a key (no override), so the file loaded first wins.
 *
 * - Installed binary: ~/.nomos/.env first -- it owns the config; a stray CWD
 *   .env only fills gaps and can never override DATABASE_URL et al.
 * - Source run (dev): repo .env first, so a developer's checked-out config
 *   drives local development as before.
 */
export function envLoadOrder(nomosDir: string, sourceRun: boolean): string[][] {
  const cwd = [".env.local", ".env"];
  const home = [join(nomosDir, ".env.local"), join(nomosDir, ".env")];
  return sourceRun ? [cwd, home] : [home, cwd];
}
