/**
 * Autonomous loop manager.
 *
 * Loads loop definitions from LOOP.md files (three-tier: bundled → personal → project)
 * and seeds them into the cron_jobs table on daemon startup (idempotent).
 *
 * Loops are seeded as disabled by default. Enable them via:
 *   nomos cron enable <name>
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDb } from "../db/client.ts";
import { parseFrontmatter } from "../skills/frontmatter.ts";

interface AutonomousLoop {
  name: string;
  description: string;
  schedule: string;
  scheduleType: "cron";
  prompt: string;
  sessionTarget: "main" | "isolated";
  deliveryMode: "none" | "announce";
  enabled: boolean;
  source: string;
}

/**
 * Load LOOP.md files from a single directory.
 * Each loop is a subdirectory containing a LOOP.md file.
 */
function loadLoopsFromDir(dir: string, source: string): AutonomousLoop[] {
  if (!fs.existsSync(dir)) return [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const loops: AutonomousLoop[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;

    const loopMd = path.join(dir, entry.name, "LOOP.md");
    if (!fs.existsSync(loopMd)) continue;

    try {
      const raw = fs.readFileSync(loopMd, "utf-8");
      const { frontmatter, body } = parseFrontmatter(raw);

      if (!frontmatter.schedule) continue;

      loops.push({
        name: frontmatter.name ?? entry.name,
        description: frontmatter.description ?? "",
        schedule: frontmatter.schedule,
        scheduleType: "cron",
        prompt: body.trim(),
        sessionTarget: (frontmatter["session-target"] as "main" | "isolated") ?? "main",
        deliveryMode: (frontmatter["delivery-mode"] as "none" | "announce") ?? "none",
        enabled: frontmatter.enabled === "true",
        source,
      });
    } catch {
      // Skip malformed loop files
    }
  }

  return loops;
}

/**
 * Resolve the bundled autonomous/ directory.
 * Works in both dev (project root) and installed (relative to entry point) modes.
 */
function resolveBundledDir(): string | null {
  const candidates = [
    path.resolve("autonomous"),
    path.resolve(path.dirname(process.argv[1] ?? ""), "..", "autonomous"),
  ];

  for (const dir of candidates) {
    if (!fs.existsSync(dir)) continue;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      const hasLoop = entries.some((e) => {
        if (!e.isDirectory()) return false;
        return fs.existsSync(path.join(dir, e.name, "LOOP.md"));
      });
      if (hasLoop) return dir;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Load all loops from three tiers.
 * Precedence (highest wins): project > personal > bundled
 */
export function loadAllLoops(): AutonomousLoop[] {
  const bundledDir = resolveBundledDir();
  const personalDir = path.join(os.homedir(), ".nomos", "autonomous");
  const projectDir = path.resolve(".nomos", "autonomous");

  const merged = new Map<string, AutonomousLoop>();

  // Load in precedence order (lowest first, later overwrites)
  if (bundledDir) {
    for (const loop of loadLoopsFromDir(bundledDir, "bundled")) {
      merged.set(loop.name, loop);
    }
  }
  for (const loop of loadLoopsFromDir(personalDir, "personal")) {
    merged.set(loop.name, loop);
  }
  for (const loop of loadLoopsFromDir(projectDir, "project")) {
    merged.set(loop.name, loop);
  }

  return Array.from(merged.values());
}

/**
 * Seed autonomous loop definitions into the cron_jobs table.
 *
 * Uses INSERT ... ON CONFLICT (name) DO NOTHING for idempotency.
 * Safe to call on every daemon start.
 */
export async function seedAutonomousLoops(): Promise<void> {
  const sql = getDb();
  const loops = loadAllLoops();
  let seeded = 0;

  for (const loop of loops) {
    const result = await sql`
      INSERT INTO cron_jobs (
        name, schedule, schedule_type, session_target, delivery_mode,
        prompt, enabled, error_count
      )
      VALUES (
        ${loop.name},
        ${loop.schedule},
        ${loop.scheduleType},
        ${loop.sessionTarget},
        ${loop.deliveryMode},
        ${loop.prompt},
        ${loop.enabled},
        ${0}
      )
      ON CONFLICT (name) DO NOTHING
      RETURNING id
    `;
    if (result.length > 0) {
      seeded++;
    }
  }

  if (seeded > 0) {
    console.log(`[autonomous] Seeded ${seeded} autonomous loop(s)`);
  } else {
    console.log(`[autonomous] All ${loops.length} autonomous loops already seeded`);
  }
}

/**
 * Get the loaded loop definitions for reference.
 */
export function getLoopDefinitions(): readonly AutonomousLoop[] {
  return loadAllLoops();
}
