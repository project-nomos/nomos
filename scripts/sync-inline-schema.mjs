#!/usr/bin/env node
/**
 * Sync the inline schema strings in src/db/migrate.ts and
 * settings/src/lib/schema.ts from the canonical src/db/schema.sql.
 *
 * Run this whenever schema.sql changes (also wired into pnpm prebuild).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const schemaPath = path.join(repoRoot, "src/db/schema.sql");
const canonical = fs.readFileSync(schemaPath, "utf-8").trim();

// The schema is embedded into a JS template literal below, so a backtick or a `${`
// sequence in schema.sql (even inside a `-- comment`) silently produces invalid
// TypeScript that only blows up later at build time with a cryptic parse error.
// Fail fast here with a pointer to the offending line instead.
for (const bad of ["`", "${"]) {
  const idx = canonical.indexOf(bad);
  if (idx !== -1) {
    const line = canonical.slice(0, idx).split("\n").length;
    throw new Error(
      `[sync-inline-schema] schema.sql contains ${JSON.stringify(bad)} at line ${line}, ` +
        `which breaks the inline template literal. Use plain quotes in SQL comments.`,
    );
  }
}

const targets = [
  path.join(repoRoot, "src/db/migrate.ts"),
  path.join(repoRoot, "settings/src/lib/schema.ts"),
];

let touched = 0;
for (const target of targets) {
  const src = fs.readFileSync(target, "utf-8");
  // Replace whatever is inside `return \`...\`` of the first function that
  // contains a CREATE EXTENSION line. Both files have getInlineSchema().
  const re = /(return\s*`)([\s\S]*?CREATE EXTENSION[\s\S]*?)(`\s*\.trim\(\)?\s*;?\s*\})/;
  if (!re.test(src)) {
    console.warn(`[sync-inline-schema] No inline block found in ${target}`);
    continue;
  }
  const next = src.replace(re, (_m, pre, _body, post) => `${pre}\n${canonical}\n  ${post}`);
  if (next !== src) {
    fs.writeFileSync(target, next);
    touched++;
    console.log(`[sync-inline-schema] Updated ${path.relative(repoRoot, target)}`);
  } else {
    console.log(`[sync-inline-schema] Already in sync: ${path.relative(repoRoot, target)}`);
  }
}

if (touched === 0) {
  console.log("[sync-inline-schema] No changes.");
}
