import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DiskBackgroundTaskStore } from "./background-tasks-disk.ts";

const SESSION = { sessionKey: "slack:C1", platform: "slack", channelId: "C1", userId: "local" };

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bgtask-"));
  file = join(dir, "tasks.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("DiskBackgroundTaskStore (power-user; survives restart)", () => {
  it("register -> listPending -> get round-trips", async () => {
    const s = new DiskBackgroundTaskStore(file);
    const t = await s.register({ ...SESSION, kind: "ci", summary: "deploy", watch: "echo X" });
    expect((await s.listPending()).map((p) => p.id)).toContain(t.id);
    expect((await s.get(t.id))?.summary).toBe("deploy");
  });

  it("PERSISTS pending tasks across a restart (a fresh instance reloads from disk)", async () => {
    const before = new DiskBackgroundTaskStore(file);
    const t = await before.register({ ...SESSION, kind: "ci", summary: "deploy", watch: "echo X" });

    // Simulate a daemon restart: a brand-new store reads the same file.
    const after = new DiskBackgroundTaskStore(file);
    const pending = await after.listPending();
    expect(pending.map((p) => p.id)).toContain(t.id);
    expect((await after.get(t.id))?.summary).toBe("deploy");
  });

  it("drops settled tasks from disk (a restart does not resurrect them)", async () => {
    const before = new DiskBackgroundTaskStore(file);
    const t = await before.register({ ...SESSION, kind: "ci", summary: "x", watch: "echo X" });
    await before.markSettled(t.id, "completed", "done: success");

    const after = new DiskBackgroundTaskStore(file);
    expect(await after.listPending()).toHaveLength(0);
    expect(await after.get(t.id)).toBeUndefined();
  });

  it("pendingForSession scopes by conversation", async () => {
    const s = new DiskBackgroundTaskStore(file);
    await s.register({ ...SESSION, kind: "ci", summary: "mine", watch: "echo X" });
    await s.register({
      ...SESSION,
      sessionKey: "slack:OTHER",
      channelId: "OTHER",
      kind: "ci",
      summary: "theirs",
      watch: "echo X",
    });
    expect(await s.pendingForSession(SESSION.sessionKey)).toHaveLength(1);
    expect(await s.pendingForSession("slack:OTHER")).toHaveLength(1);
  });
});
