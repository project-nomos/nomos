/**
 * File sync: keeps disk config files in sync with the database.
 *
 * Flow:
 *   1. On startup: file exists? sync file -> DB. No file? restore DB -> disk.
 *   2. Runtime: agent reads from disk (fast). Edits go to disk as usual.
 *   3. After changes: call syncFileToDb() to persist (fire-and-forget).
 *
 * Covers: SOUL.md, TOOLS.md, IDENTITY.md, agents.json, mcp.json,
 * and all skill SKILL.md files.
 */

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { getKysely } from "../db/client.ts";

// ── Paths ──

const HOME_NOMOS = path.join(process.env.HOME ?? "", ".nomos");

/** Files to sync, keyed by their DB path identifier. */
interface ManagedFile {
  /** Relative key stored in DB (e.g., "SOUL.md", "skills/commit/SKILL.md"). */
  dbPath: string;
  /** Absolute disk paths to check, in priority order. */
  diskPaths: string[];
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

// ── Core sync functions ──

/**
 * Sync a single file: disk -> DB if file exists, DB -> disk if not.
 * Returns the content (from whichever source had it).
 */
async function syncOne(file: ManagedFile): Promise<string | null> {
  const db = getKysely();

  // Check disk (first path that exists wins)
  let diskContent: string | null = null;
  let diskPath: string | null = null;
  for (const p of file.diskPaths) {
    if (fs.existsSync(p)) {
      diskContent = fs.readFileSync(p, "utf-8");
      diskPath = p;
      break;
    }
  }

  if (diskContent !== null) {
    // File exists on disk -> sync to DB
    const hash = sha256(diskContent);
    await db
      .insertInto("managed_files")
      .values({
        path: file.dbPath,
        content: diskContent,
        hash,
      })
      .onConflict((oc) =>
        oc.column("path").doUpdateSet({
          content: diskContent!,
          hash,
          updated_at: new Date(),
        }),
      )
      .execute();
    return diskContent;
  }

  // No file on disk -> try restoring from DB
  const row = await db
    .selectFrom("managed_files")
    .select(["content"])
    .where("path", "=", file.dbPath)
    .executeTakeFirst();

  if (row?.content) {
    // Restore to the first (preferred) disk path
    const restorePath = file.diskPaths[0];
    const dir = path.dirname(restorePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(restorePath, row.content, "utf-8");
    console.log(`[file-sync] Restored ${file.dbPath} -> ${restorePath}`);
    return row.content;
  }

  return null; // neither disk nor DB has this file
}

/**
 * Sync a single file from disk to DB (after a change).
 * Fire-and-forget safe.
 */
export async function syncFileToDb(dbPath: string, content: string): Promise<void> {
  try {
    const db = getKysely();
    const hash = sha256(content);
    await db
      .insertInto("managed_files")
      .values({ path: dbPath, content, hash })
      .onConflict((oc) =>
        oc.column("path").doUpdateSet({
          content,
          hash,
          updated_at: new Date(),
        }),
      )
      .execute();
  } catch (err) {
    console.warn(
      `[file-sync] Failed to sync ${dbPath} to DB:`,
      err instanceof Error ? err.message : err,
    );
  }
}

// ── Skill sync ──

/**
 * Sync all skill SKILL.md files from a directory.
 */
async function syncSkillDir(dir: string, prefix: string): Promise<number> {
  if (!fs.existsSync(dir)) return 0;

  let synced = 0;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillFile = path.join(dir, entry.name, "SKILL.md");
      if (!fs.existsSync(skillFile)) continue;

      const dbPath = `${prefix}/${entry.name}/SKILL.md`;
      const content = fs.readFileSync(skillFile, "utf-8");
      await syncFileToDb(dbPath, content);
      synced++;
    }
  } catch {
    // directory not readable
  }
  return synced;
}

/**
 * Restore skills from DB to disk for a given prefix.
 */
async function restoreSkillsFromDb(dir: string, prefix: string): Promise<number> {
  const db = getKysely();
  const rows = await db
    .selectFrom("managed_files")
    .select(["path", "content"])
    .where("path", "like", `${prefix}/%`)
    .execute();

  let restored = 0;
  for (const row of rows) {
    // Convert DB path back to disk path
    // DB: "skills/commit/SKILL.md" -> disk: "{dir}/commit/SKILL.md"
    const relativePath = row.path.slice(prefix.length + 1); // remove "skills/"
    const diskPath = path.join(dir, relativePath);
    if (!fs.existsSync(diskPath)) {
      fs.mkdirSync(path.dirname(diskPath), { recursive: true });
      fs.writeFileSync(diskPath, row.content, "utf-8");
      restored++;
    }
  }
  return restored;
}

// ── Main entry point ──

/** CWD-relative .nomos dir (project-local config). */
function projectNomosDir(): string {
  return path.resolve(process.cwd(), ".nomos");
}

/**
 * Run full sync on startup. Call once during daemon/CLI initialization.
 *
 * For each managed file:
 *   - If file exists on disk, sync content to DB (DB stays current).
 *   - If file doesn't exist on disk but is in DB, restore to disk.
 */
export async function syncAllFiles(): Promise<void> {
  const projectDir = projectNomosDir();
  const cwd = process.cwd();

  // Core config files
  const coreFiles: ManagedFile[] = [
    {
      dbPath: "SOUL.md",
      diskPaths: [path.join(projectDir, "SOUL.md"), path.join(HOME_NOMOS, "SOUL.md")],
    },
    {
      dbPath: "TOOLS.md",
      diskPaths: [path.join(projectDir, "TOOLS.md"), path.join(HOME_NOMOS, "TOOLS.md")],
    },
    {
      dbPath: "IDENTITY.md",
      diskPaths: [path.join(projectDir, "IDENTITY.md"), path.join(HOME_NOMOS, "IDENTITY.md")],
    },
    {
      dbPath: "agents.json",
      diskPaths: [path.join(projectDir, "agents.json"), path.join(HOME_NOMOS, "agents.json")],
    },
    {
      dbPath: "mcp.json",
      diskPaths: [
        path.join(projectDir, "mcp.json"),
        path.join(projectDir, "mcp-servers.json"),
        path.join(HOME_NOMOS, "mcp.json"),
      ],
    },
  ];

  let synced = 0;
  let restored = 0;

  for (const file of coreFiles) {
    const result = await syncOne(file);
    if (result !== null) {
      // Check if it was a restore (file didn't exist before)
      const existed = file.diskPaths.some((p) => fs.existsSync(p));
      if (existed) synced++;
      else restored++;
    }
  }

  // Sync bundled skills (project/skills/)
  const bundledSkillDir = path.join(cwd, "skills");
  const bundledCount = await syncSkillDir(bundledSkillDir, "skills");
  synced += bundledCount;

  // Sync personal skills (~/.nomos/skills/)
  const personalSkillDir = path.join(HOME_NOMOS, "skills");
  const personalCount = await syncSkillDir(personalSkillDir, "personal-skills");
  synced += personalCount;

  // Restore any skills from DB that aren't on disk
  const restoredPersonal = await restoreSkillsFromDb(personalSkillDir, "personal-skills");
  restored += restoredPersonal;

  if (synced > 0 || restored > 0) {
    console.log(
      `[file-sync] Synced ${synced} file(s) to DB` +
        (restored > 0 ? `, restored ${restored} from DB` : ""),
    );
  }
}
