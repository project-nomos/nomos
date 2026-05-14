#!/usr/bin/env node
/**
 * Copy .next/static and public/ into the Next.js standalone output.
 *
 * Next.js does NOT copy these automatically in standalone mode -- a
 * well-known gotcha. Without this, the served app loads as unstyled HTML.
 *
 * Handles both layouts:
 *   - monorepo: .next/standalone/settings/
 *   - flat:     .next/standalone/
 */
import fs from "node:fs";
import path from "node:path";

const STANDALONE_ROOT = ".next/standalone";

function findStandaloneDir() {
  if (!fs.existsSync(STANDALONE_ROOT)) return null;
  // Monorepo layout: .next/standalone/<project-name>/
  const nested = path.join(STANDALONE_ROOT, "settings");
  if (fs.existsSync(path.join(nested, "server.js"))) return nested;
  // Flat layout: .next/standalone/server.js
  if (fs.existsSync(path.join(STANDALONE_ROOT, "server.js"))) return STANDALONE_ROOT;
  return null;
}

function copyDir(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
}

const standaloneDir = findStandaloneDir();
if (!standaloneDir) {
  console.error("[copy-static] No .next/standalone/server.js found, skipping");
  process.exit(0);
}

if (fs.existsSync(".next/static")) {
  copyDir(".next/static", path.join(standaloneDir, ".next", "static"));
  console.log(`[copy-static] Copied .next/static -> ${standaloneDir}/.next/static`);
}

if (fs.existsSync("public")) {
  copyDir("public", path.join(standaloneDir, "public"));
  console.log(`[copy-static] Copied public -> ${standaloneDir}/public`);
}
