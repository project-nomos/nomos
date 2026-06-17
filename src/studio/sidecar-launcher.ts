/**
 * Lifecycle for the Phase-3 Studio beauty-ops sidecar (`nomos-studio-sidecar`).
 * Three launch modes, one HTTP contract:
 *   - NOMOS_STUDIO_SIDECAR_URL set -> use that already-running instance (no spawn).
 *   - else spawn `uv run --project <path> nomos-studio-sidecar` from the sibling
 *     clone (default `../nomos-studio-sidecar`), like the imsg child process.
 *   - (prod) a pod sidecar container reachable on localhost via the URL form.
 *
 * Everything is best-effort: if the sidecar can't be reached/spawned, the URL
 * stays null and retouch falls through to the generative fallback. The resolved
 * URL is a daemon-scoped singleton read by `buildStudioEngine` (which runs
 * per-turn), so the process is launched once, not per request.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { createLogger } from "../lib/logger.ts";

const log = createLogger("studio-sidecar");

let sidecarUrl: string | null = null;
let child: ChildProcess | null = null;
let stopping = false;
let exitHookInstalled = false;

/** Synchronous best-effort group-kill so a process.exit (incl. the
 * uncaughtException path that skips the async gateway.stop) never orphans the
 * `uv`/python tree. Registered once, when we first spawn. */
function installExitBackstop(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", () => {
    if (child?.pid) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        try {
          child.kill("SIGTERM");
        } catch {
          // already gone
        }
      }
    }
  });
}

export function getStudioSidecarUrl(): string | null {
  return sidecarUrl;
}

/** Test seam: point the engine at a known sidecar without spawning. */
export function setStudioSidecarUrl(url: string | null): void {
  sidecarUrl = url;
}

async function healthOk(url: string): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1500);
    const resp = await fetch(`${url}/healthz`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!resp.ok) return false;
    const j = (await resp.json()) as { status?: string };
    return j.status === "ok";
  } catch {
    return false;
  }
}

/**
 * Resolve a sidecar URL, spawning the process if needed. Returns the URL on
 * success or null (caller treats null as "generative fallback"). Idempotent:
 * returns the existing URL if already up.
 */
export async function ensureStudioSidecar(): Promise<string | null> {
  if (sidecarUrl) return sidecarUrl;

  const explicit = process.env.NOMOS_STUDIO_SIDECAR_URL;
  if (explicit) {
    if (await healthOk(explicit)) {
      sidecarUrl = explicit;
      log.info({ url: explicit }, "studio sidecar: using external instance");
      return explicit;
    }
    log.warn(
      { url: explicit },
      "studio sidecar: external URL unreachable; retouch falls back to cloud",
    );
    return null;
  }

  const projectPath = process.env.NOMOS_STUDIO_SIDECAR_PATH ?? "../nomos-studio-sidecar";
  const port = process.env.NOMOS_STUDIO_SIDECAR_PORT ?? "8799";
  const url = `http://127.0.0.1:${port}`;

  // Adopt an instance already listening on the port (e.g. an orphan from a prior
  // hard-kill) instead of spawning a duplicate that would hit EADDRINUSE.
  if (await healthOk(url)) {
    sidecarUrl = url;
    log.info({ url }, "studio sidecar: adopted an instance already on the port");
    return url;
  }

  stopping = false;
  try {
    // detached:true -> own process group, so teardown can group-kill the python
    // grandchild uv spawns. stdio ignored so unread pipes can't fill/block or
    // keep the event loop alive.
    child = spawn("uv", ["run", "--project", projectPath, "nomos-studio-sidecar"], {
      stdio: ["ignore", "ignore", "ignore"],
      detached: true,
      env: { ...process.env, NOMOS_STUDIO_SIDECAR_PORT: port },
    });
    installExitBackstop();
    const myPid = child.pid;
    child.unref();
    child.on("error", (err) => {
      if (!stopping) log.warn({ err }, "studio sidecar: spawn error; retouch falls back to cloud");
    });
    child.on("exit", (code) => {
      if (!stopping) log.warn({ code }, "studio sidecar exited");
      // Only clear if THIS child is still the tracked one (guard re-adopt races).
      if (child?.pid === myPid) {
        child = null;
        sidecarUrl = null;
      }
    });
  } catch (err) {
    log.warn({ err }, "studio sidecar: could not spawn uv; retouch falls back to cloud");
    return null;
  }

  // Cold `uv run` resolves + installs a heavy venv (MediaPipe/OpenCV) on first
  // boot, which can far exceed 15s — make the budget generous + env-tunable.
  const bootMs = Number(process.env.NOMOS_STUDIO_SIDECAR_BOOT_MS ?? "90000");
  const deadline = bootMs > 0 ? bootMs : 90000;
  const stepMs = 500;
  for (let waited = 0; waited < deadline; waited += stepMs) {
    if (await healthOk(url)) {
      sidecarUrl = url;
      log.info({ url, projectPath }, "studio sidecar: ready");
      return url;
    }
    await new Promise((r) => setTimeout(r, stepMs));
  }
  log.warn({ bootMs: deadline }, "studio sidecar: did not become healthy in time; tearing down");
  await stopStudioSidecar();
  return null;
}

export async function stopStudioSidecar(): Promise<void> {
  stopping = true;
  sidecarUrl = null;
  if (child?.pid) {
    // Kill the whole process group (uv + the python grandchild). Fall back to a
    // direct kill if the group signal fails.
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      try {
        child.kill("SIGTERM");
      } catch {
        // already gone
      }
    }
    child = null;
  }
}
