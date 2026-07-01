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
import { createLogger } from "../lib/logger.ts";

const log = createLogger("file-sync");

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
  for (const p of file.diskPaths) {
    if (fs.existsSync(p)) {
      diskContent = fs.readFileSync(p, "utf-8");
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
    log.info({ dbPath: file.dbPath, restorePath }, "Restored");
    return row.content;
  }

  return null; // neither disk nor DB has this file
}

/**
 * Read a managed file's content straight from the DB (the source of truth in
 * BOTH modes). Power-user boot syncs disk -> DB, so this is current as of boot;
 * hosted has no disk at all, so the DB is the only copy. Callers that must work
 * identically in both modes (e.g. the wiki compiler reading WIKI.md conventions)
 * should read here rather than the filesystem.
 */
export async function readManagedFile(dbPath: string): Promise<string | null> {
  try {
    const db = getKysely();
    const row = await db
      .selectFrom("managed_files")
      .select(["content"])
      .where("path", "=", dbPath)
      .executeTakeFirst();
    return row?.content ?? null;
  } catch {
    return null;
  }
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
    log.warn({ dbPath, err: err instanceof Error ? err.message : err }, "Failed to sync to DB");
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
      // Wiki conventions doc (Karpathy's "schema" layer): how the compiler should
      // structure/path/link articles. A default is seeded into managed_files by the
      // migration so both modes have a baseline; power-user users can edit the file,
      // hosted users edit it via the Settings UI. The compiler reads it from the DB.
      dbPath: "WIKI.md",
      diskPaths: [path.join(projectDir, "WIKI.md"), path.join(HOME_NOMOS, "WIKI.md")],
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
    log.info(
      { synced, restored },
      `Synced ${synced} file(s) to DB` + (restored > 0 ? `, restored ${restored} from DB` : ""),
    );
  }
}
