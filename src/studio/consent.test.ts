import { beforeEach, describe, expect, it, vi } from "vitest";

const { getConfigValue, setConfigValue } = vi.hoisted(() => ({
  getConfigValue: vi.fn(),
  setConfigValue: vi.fn(),
}));
vi.mock("../db/config.ts", () => ({ getConfigValue, setConfigValue }));

import {
  assertCloudAIConsent,
  CLOUD_AI_CONSENT_KEY,
  ConsentRequiredError,
  isCloudAIEnabled,
  setCloudAIEnabled,
} from "./consent.ts";

beforeEach(() => {
  getConfigValue.mockReset();
  setConfigValue.mockReset();
  delete process.env.NOMOS_STUDIO_CLOUD_AI;
});

describe("cloud AI consent", () => {
  it("defaults to disabled when unset", async () => {
    getConfigValue.mockResolvedValue(null);
    expect(await isCloudAIEnabled()).toBe(false);
  });

  it("is enabled only for an explicit true", async () => {
    getConfigValue.mockResolvedValue(true);
    expect(await isCloudAIEnabled()).toBe(true);
    getConfigValue.mockResolvedValue("true");
    expect(await isCloudAIEnabled()).toBe(false); // not the boolean true
  });

  it("assertCloudAIConsent throws when off", async () => {
    await expect(assertCloudAIConsent(async () => false)).rejects.toBeInstanceOf(
      ConsentRequiredError,
    );
  });

  it("assertCloudAIConsent passes when on", async () => {
    await expect(assertCloudAIConsent(async () => true)).resolves.toBeUndefined();
  });

  it("setCloudAIEnabled writes the consent config key", async () => {
    await setCloudAIEnabled(true);
    expect(setConfigValue).toHaveBeenCalledWith(CLOUD_AI_CONSENT_KEY, true);
  });

  it("honors the NOMOS_STUDIO_CLOUD_AI dev override even when the DB flag is off", async () => {
    getConfigValue.mockResolvedValue(false);
    process.env.NOMOS_STUDIO_CLOUD_AI = "1";
    expect(await isCloudAIEnabled()).toBe(true);
    process.env.NOMOS_STUDIO_CLOUD_AI = "true";
    expect(await isCloudAIEnabled()).toBe(true);
    process.env.NOMOS_STUDIO_CLOUD_AI = "0";
    expect(await isCloudAIEnabled()).toBe(false); // falsy override → DB flag (off)
  });
});
