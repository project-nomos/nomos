import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the token/account layer so gapiFetch + the builders are testable without a DB.
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

/** Tool names registered on an SDK MCP server instance. */
function toolNames(server: { instance: unknown }): string[] {
  const reg = (server.instance as { _registeredTools?: Record<string, unknown> })._registeredTools;
  return reg ? Object.keys(reg) : [];
}

const {
  gapiFetch,
  buildRfc822,
  buildGoogleRestMcpServer,
  createGoogleRestMcpServer,
  createGoogleSendMcpServer,
} = await import("./google-rest-mcp.ts");

const fetchMock = vi.fn();
beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  getValidAccessToken.mockReset();
  listGoogleAccounts.mockReset();
  isGoogleIntegrationConfigured.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

function res(status: number, body: unknown): Response {
  const text = body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `S${status}`,
    text: async () => text,
  } as Response;
}

describe("buildRfc822", () => {
  it("encodes a base64url RFC822 message with headers + body", () => {
    const raw = buildRfc822({ to: "a@x.com", subject: "Hi", body: "Hello there", cc: "c@x.com" });
    const decoded = Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(
      "utf8",
    );
    expect(decoded).toContain("To: a@x.com");
    expect(decoded).toContain("Cc: c@x.com");
    expect(decoded).toContain("Subject: Hi");
    expect(decoded).toMatch(/\r\n\r\nHello there$/);
    expect(raw).not.toMatch(/[+/=]/); // url-safe, unpadded
  });

  it("RFC2047-encodes non-ASCII subjects", () => {
    const raw = buildRfc822({ to: "a@x.com", subject: "Café ☕", body: "b" });
    const decoded = Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(
      "utf8",
    );
    expect(decoded).toMatch(/Subject: =\?UTF-8\?B\?/);
  });
});

describe("gapiFetch", () => {
  it("attaches the bearer token, appends query params, returns parsed JSON", async () => {
    getValidAccessToken.mockResolvedValue("tok123");
    fetchMock.mockResolvedValue(res(200, { ok: true, n: 1 }));

    const out = await gapiFetch({
      userId: "u1",
      account: "me@x.com",
      method: "GET",
      url: "https://gmail.googleapis.com/gmail/v1/users/me/messages",
      query: { q: "is:unread", maxResults: 5, metadataHeaders: ["From", "Subject"] },
    });

    expect(out).toEqual({ ok: true, n: 1 });
    expect(getValidAccessToken).toHaveBeenCalledWith("u1", "me@x.com");
    const [calledUrl, init] = fetchMock.mock.calls[0];
    expect((calledUrl as URL).searchParams.get("q")).toBe("is:unread");
    expect((calledUrl as URL).searchParams.get("maxResults")).toBe("5");
    expect((calledUrl as URL).searchParams.getAll("metadataHeaders")).toEqual(["From", "Subject"]);
    expect((init as RequestInit).headers).toMatchObject({ authorization: "Bearer tok123" });
  });

  it("sends a JSON body with content-type for writes", async () => {
    getValidAccessToken.mockResolvedValue("tok123");
    fetchMock.mockResolvedValue(res(200, { id: "evt1" }));

    await gapiFetch({
      userId: "u1",
      method: "POST",
      url: "https://www.googleapis.com/calendar/v3/calendars/primary/events",
      body: { summary: "Meet" },
    });

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect(init.body).toBe(JSON.stringify({ summary: "Meet" }));
  });

  it("returns null on 204 (delete)", async () => {
    getValidAccessToken.mockResolvedValue("tok123");
    fetchMock.mockResolvedValue(res(204, undefined));
    expect(await gapiFetch({ userId: "u1", method: "DELETE", url: "https://x/y" })).toBeNull();
  });

  it("throws reconnect guidance on 401/403", async () => {
    getValidAccessToken.mockResolvedValue("tok123");
    fetchMock.mockResolvedValue(res(403, { error: { code: 403, message: "Insufficient" } }));
    await expect(gapiFetch({ userId: "u1", method: "GET", url: "https://x/y" })).rejects.toThrow(
      /reconnect/i,
    );
  });

  it("throws when there is no valid token", async () => {
    getValidAccessToken.mockResolvedValue(null);
    await expect(
      gapiFetch({ userId: "u1", account: "me@x.com", method: "GET", url: "https://x/y" }),
    ).rejects.toThrow(/no valid Google token for me@x.com/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("buildGoogleRestMcpServer", () => {
  it("returns {} when Google isn't configured", async () => {
    isGoogleIntegrationConfigured.mockReturnValue(false);
    expect(await buildGoogleRestMcpServer("u1")).toEqual({});
    expect(listGoogleAccounts).not.toHaveBeenCalled();
  });

  it("returns {} when the user has no connected accounts", async () => {
    isGoogleIntegrationConfigured.mockReturnValue(true);
    listGoogleAccounts.mockResolvedValue([]);
    expect(await buildGoogleRestMcpServer("u1")).toEqual({});
  });

  it("returns the nomos-google server when an account is connected", async () => {
    isGoogleIntegrationConfigured.mockReturnValue(true);
    listGoogleAccounts.mockResolvedValue([
      { email: "me@x.com", isDefault: true, sendEnabled: false },
    ]);
    const servers = await buildGoogleRestMcpServer("u1");
    expect(Object.keys(servers)).toEqual(["nomos-google"]);
    expect(servers["nomos-google"].name).toBe("nomos-google");
  });

  it("exposes send tools only when an account has sending enabled", async () => {
    isGoogleIntegrationConfigured.mockReturnValue(true);

    listGoogleAccounts.mockResolvedValue([
      { email: "me@x.com", isDefault: true, sendEnabled: false },
    ]);
    const draftOnly = await buildGoogleRestMcpServer("u1");
    expect(toolNames(draftOnly["nomos-google"])).not.toContain("gmail_send_message");

    listGoogleAccounts.mockResolvedValue([
      { email: "me@x.com", isDefault: true, sendEnabled: true },
    ]);
    const withSend = await buildGoogleRestMcpServer("u1");
    expect(toolNames(withSend["nomos-google"])).toContain("gmail_send_message");
  });
});

describe("createGoogleRestMcpServer send-gating", () => {
  it("draft-only by default: no send tools, but create_draft is present", () => {
    const names = toolNames(createGoogleRestMcpServer("u1"));
    expect(names).toContain("gmail_create_draft");
    expect(names).not.toContain("gmail_send_message");
    expect(names).not.toContain("gmail_send_draft");
  });

  it("registers send tools when sendEnabled", () => {
    const names = toolNames(createGoogleRestMcpServer("u1", { sendEnabled: true }));
    expect(names).toContain("gmail_send_message");
    expect(names).toContain("gmail_send_draft");
  });

  it("send-only server exposes exactly the two send tools", () => {
    expect(toolNames(createGoogleSendMcpServer("u1")).sort()).toEqual([
      "gmail_send_draft",
      "gmail_send_message",
    ]);
  });

  it("builds a valid in-process SDK server", () => {
    const server = createGoogleRestMcpServer("u1");
    expect(server.type).toBe("sdk");
    expect(server.name).toBe("nomos-google");
  });
});
