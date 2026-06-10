import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./config.ts", () => ({
  getConfigValue: vi.fn(),
  setConfigValue: vi.fn(),
  deleteConfigValue: vi.fn(),
}));

import { getConfigValue } from "./config.ts";
import { getNotificationDefaultFor } from "./notification-defaults.ts";

const get = getConfigValue as unknown as ReturnType<typeof vi.fn>;

describe("getNotificationDefaultFor", () => {
  beforeEach(() => get.mockReset());

  it("prefers the per-owner target over the global default", async () => {
    get.mockImplementation(async (key: string) =>
      key === "notifications.default:alice"
        ? { platform: "slack", channelId: "ALICE" }
        : { platform: "slack", channelId: "GLOBAL" },
    );
    expect((await getNotificationDefaultFor("alice"))?.channelId).toBe("ALICE");
  });

  it("falls back to the global default when no per-owner target is set", async () => {
    get.mockImplementation(async (key: string) =>
      key === "notifications.default" ? { platform: "slack", channelId: "GLOBAL" } : null,
    );
    expect((await getNotificationDefaultFor("bob"))?.channelId).toBe("GLOBAL");
  });

  it("returns null when neither per-owner nor global is set", async () => {
    get.mockResolvedValue(null);
    expect(await getNotificationDefaultFor("bob")).toBeNull();
  });
});
