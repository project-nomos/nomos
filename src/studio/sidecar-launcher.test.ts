import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ensureStudioSidecar,
  getStudioSidecarUrl,
  setStudioSidecarUrl,
} from "./sidecar-launcher.ts";

const ENV = process.env.NOMOS_STUDIO_SIDECAR_URL;

beforeEach(() => {
  setStudioSidecarUrl(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
  setStudioSidecarUrl(null);
  if (ENV === undefined) delete process.env.NOMOS_STUDIO_SIDECAR_URL;
  else process.env.NOMOS_STUDIO_SIDECAR_URL = ENV;
});

describe("ensureStudioSidecar (external URL mode)", () => {
  it("uses a healthy external URL without spawning a process", async () => {
    process.env.NOMOS_STUDIO_SIDECAR_URL = "http://127.0.0.1:9999";
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
      ok: true,
      json: async () => ({ status: "ok" }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const url = await ensureStudioSidecar();
    expect(url).toBe("http://127.0.0.1:9999");
    expect(getStudioSidecarUrl()).toBe("http://127.0.0.1:9999");
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://127.0.0.1:9999/healthz");
  });

  it("returns null (cloud fallback) when the external URL is unhealthy, never spawning", async () => {
    process.env.NOMOS_STUDIO_SIDECAR_URL = "http://127.0.0.1:9999";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 503 })),
    );
    const url = await ensureStudioSidecar();
    expect(url).toBeNull();
    expect(getStudioSidecarUrl()).toBeNull();
  });

  it("is idempotent: returns the cached URL without re-checking", async () => {
    setStudioSidecarUrl("http://127.0.0.1:8799");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const url = await ensureStudioSidecar();
    expect(url).toBe("http://127.0.0.1:8799");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
