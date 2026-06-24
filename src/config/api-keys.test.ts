import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { getIntegration } = vi.hoisted(() => ({ getIntegration: vi.fn() }));
vi.mock("../db/integrations.ts", () => ({ getIntegration }));

import { hydrateApiKeysFromIntegrations } from "./api-keys.ts";

describe("hydrateApiKeysFromIntegrations", () => {
  const saved = {
    google: process.env.GOOGLE_API_KEY,
    gemini: process.env.GEMINI_API_KEY,
  };
  beforeEach(() => {
    getIntegration.mockReset();
    delete process.env.GOOGLE_API_KEY;
    delete process.env.GEMINI_API_KEY;
  });
  afterEach(() => {
    if (saved.google === undefined) delete process.env.GOOGLE_API_KEY;
    else process.env.GOOGLE_API_KEY = saved.google;
    if (saved.gemini === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = saved.gemini;
  });

  it("loads the google-ai api_key into GOOGLE_API_KEY and GEMINI_API_KEY", async () => {
    getIntegration.mockResolvedValue({
      enabled: true,
      secrets: { api_key: "AIza-TEST" },
      config: {},
    });
    await hydrateApiKeysFromIntegrations();
    expect(process.env.GOOGLE_API_KEY).toBe("AIza-TEST");
    expect(process.env.GEMINI_API_KEY).toBe("AIza-TEST");
  });

  it("never overrides a key already set in the environment", async () => {
    process.env.GOOGLE_API_KEY = "from-env";
    getIntegration.mockResolvedValue({
      enabled: true,
      secrets: { api_key: "from-db" },
      config: {},
    });
    await hydrateApiKeysFromIntegrations();
    expect(process.env.GOOGLE_API_KEY).toBe("from-env");
  });

  it("is a no-op when the integration is absent or disabled", async () => {
    getIntegration.mockResolvedValue(null);
    await hydrateApiKeysFromIntegrations();
    expect(process.env.GOOGLE_API_KEY).toBeUndefined();

    getIntegration.mockResolvedValue({ enabled: false, secrets: { api_key: "x" }, config: {} });
    await hydrateApiKeysFromIntegrations();
    expect(process.env.GOOGLE_API_KEY).toBeUndefined();
  });

  it("is a no-op when the secret has no api_key", async () => {
    getIntegration.mockResolvedValue({ enabled: true, secrets: {}, config: {} });
    await hydrateApiKeysFromIntegrations();
    expect(process.env.GOOGLE_API_KEY).toBeUndefined();
  });

  it("swallows DB errors", async () => {
    getIntegration.mockRejectedValue(new Error("no db"));
    await expect(hydrateApiKeysFromIntegrations()).resolves.toBeUndefined();
    expect(process.env.GOOGLE_API_KEY).toBeUndefined();
  });
});
