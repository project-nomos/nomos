import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the token/account layer; let google-rest-mcp build real SDK servers.
const getValidAccessToken = vi.fn();
const listGoogleAccounts = vi.fn();
const isGoogleIntegrationConfigured = vi.fn();
const isSendEnabled = vi.fn();
vi.mock("../auth/google-integration.ts", () => ({
  getValidAccessToken: (...a: unknown[]) => getValidAccessToken(...a),
  listGoogleAccounts: (...a: unknown[]) => listGoogleAccounts(...a),
  isGoogleIntegrationConfigured: (...a: unknown[]) => isGoogleIntegrationConfigured(...a),
  isSendEnabled: (...a: unknown[]) => isSendEnabled(...a),
}));

const { buildGoogleMcpServers } = await import("./google-mcp.ts");

beforeEach(() => {
  getValidAccessToken.mockReset().mockResolvedValue("tok");
  listGoogleAccounts.mockReset();
  isGoogleIntegrationConfigured.mockReset().mockReturnValue(true);
  isSendEnabled.mockReset();
});
afterEach(() => vi.unstubAllEnvs());

describe("buildGoogleMcpServers — official", () => {
  beforeEach(() => vi.stubEnv("NOMOS_GOOGLE_BACKEND", "official"));

  it("returns {} when Google isn't configured", async () => {
    isGoogleIntegrationConfigured.mockReturnValue(false);
    expect(await buildGoogleMcpServers("u1")).toEqual({});
  });

  it("returns {} when no accounts are connected", async () => {
    listGoogleAccounts.mockResolvedValue([]);
    expect(await buildGoogleMcpServers("u1")).toEqual({});
  });

  it("registers official gmail/calendar/drive HTTP servers with the bearer token", async () => {
    listGoogleAccounts.mockResolvedValue([
      { email: "me@x.com", isDefault: true, sendEnabled: false },
    ]);
    const servers = await buildGoogleMcpServers("u1");
    expect(Object.keys(servers).sort()).toEqual([
      "google-calendar",
      "google-drive",
      "google-gmail",
    ]);
    const gmail = servers["google-gmail"] as {
      type: string;
      url: string;
      headers: Record<string, string>;
    };
    expect(gmail.type).toBe("http");
    expect(gmail.url).toBe("https://gmailmcp.googleapis.com/mcp/v1");
    expect(gmail.headers.Authorization).toBe("Bearer tok");
    expect(servers["nomos-google-send"]).toBeUndefined(); // send off by default
  });

  it("adds the in-process send server only when sending is enabled", async () => {
    listGoogleAccounts.mockResolvedValue([
      { email: "me@x.com", isDefault: true, sendEnabled: true },
    ]);
    const servers = await buildGoogleMcpServers("u1");
    expect((servers["nomos-google-send"] as { type: string }).type).toBe("sdk");
  });

  it("slugs additional (non-default) accounts so multi-account names don't collide", async () => {
    listGoogleAccounts.mockResolvedValue([
      { email: "me@x.com", isDefault: true, sendEnabled: false },
      { email: "work@corp.com", isDefault: false, sendEnabled: false },
    ]);
    const keys = Object.keys(await buildGoogleMcpServers("u1"));
    expect(keys).toContain("google-gmail");
    expect(keys).toContain("google-work-corp-com-gmail");
  });

  it("skips an account with no valid token", async () => {
    listGoogleAccounts.mockResolvedValue([
      { email: "me@x.com", isDefault: true, sendEnabled: false },
    ]);
    getValidAccessToken.mockResolvedValue(null);
    expect(await buildGoogleMcpServers("u1")).toEqual({});
  });
});

describe("buildGoogleMcpServers — rest backup", () => {
  it("uses the in-process REST server when NOMOS_GOOGLE_BACKEND=rest", async () => {
    vi.stubEnv("NOMOS_GOOGLE_BACKEND", "rest");
    listGoogleAccounts.mockResolvedValue([
      { email: "me@x.com", isDefault: true, sendEnabled: false },
    ]);
    const servers = await buildGoogleMcpServers("u1");
    expect(Object.keys(servers)).toEqual(["nomos-google"]);
    expect((servers["nomos-google"] as { type: string }).type).toBe("sdk");
  });
});

describe("buildGoogleMcpServers — mode-aware default", () => {
  it("power-user (NOMOS_MODE unset): default backend is cli → no servers", async () => {
    vi.stubEnv("NOMOS_MODE", ""); // not hosted
    vi.stubEnv("NOMOS_GOOGLE_BACKEND", ""); // unset → mode-aware default
    listGoogleAccounts.mockResolvedValue([
      { email: "me@x.com", isDefault: true, sendEnabled: false },
    ]);
    expect(await buildGoogleMcpServers("u1")).toEqual({});
    // cli short-circuits before any token/account work
    expect(listGoogleAccounts).not.toHaveBeenCalled();
  });

  it("hosted (NOMOS_MODE=hosted): default backend is official → registers remote servers", async () => {
    vi.stubEnv("NOMOS_MODE", "hosted");
    vi.stubEnv("NOMOS_GOOGLE_BACKEND", ""); // unset → mode-aware default
    listGoogleAccounts.mockResolvedValue([
      { email: "me@x.com", isDefault: true, sendEnabled: false },
    ]);
    const keys = Object.keys(await buildGoogleMcpServers("u1"));
    expect(keys).toContain("google-gmail");
  });

  it("explicit NOMOS_GOOGLE_BACKEND=cli wins even in hosted → no servers", async () => {
    vi.stubEnv("NOMOS_MODE", "hosted");
    vi.stubEnv("NOMOS_GOOGLE_BACKEND", "cli");
    expect(await buildGoogleMcpServers("u1")).toEqual({});
  });
});
