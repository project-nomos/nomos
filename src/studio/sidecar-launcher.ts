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
  stopping = false;
  try {
    child = spawn("uv", ["run", "--project", projectPath, "nomos-studio-sidecar"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NOMOS_STUDIO_SIDECAR_PORT: port },
    });
    child.on("error", (err) => {
      if (!stopping) log.warn({ err }, "studio sidecar: spawn error; retouch falls back to cloud");
    });
    child.on("exit", (code) => {
      if (!stopping) log.warn({ code }, "studio sidecar exited");
      child = null;
      sidecarUrl = null;
    });
  } catch (err) {
    log.warn({ err }, "studio sidecar: could not spawn uv; retouch falls back to cloud");
    return null;
  }

  for (let i = 0; i < 30; i++) {
    if (await healthOk(url)) {
      sidecarUrl = url;
      log.info({ url, projectPath }, "studio sidecar: ready");
      return url;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  log.warn("studio sidecar: did not become healthy in time; tearing down");
  await stopStudioSidecar();
  return null;
}

export async function stopStudioSidecar(): Promise<void> {
  stopping = true;
  sidecarUrl = null;
  if (child) {
    try {
      child.kill("SIGTERM");
    } catch {
      // already gone
    }
    child = null;
  }
}
