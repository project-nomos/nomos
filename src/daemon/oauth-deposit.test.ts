import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../auth/google-integration.ts", () => ({
  fetchGoogleAccountEmail: vi.fn(),
  storeGoogleAccount: vi.fn(),
}));
vi.mock("../db/integrations.ts", () => ({ upsertIntegration: vi.fn() }));

import { depositOAuthCredential } from "./oauth-deposit.ts";
import { fetchGoogleAccountEmail, storeGoogleAccount } from "../auth/google-integration.ts";
import { upsertIntegration } from "../db/integrations.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeCall(request: Record<string, unknown>): any {
  return { request, metadata: { get: () => [] } };
}

describe("depositOAuthCredential", () => {
  beforeEach(() => vi.clearAllMocks());

  it("routes a google deposit through storeGoogleAccount (canonical, not the generic row)", async () => {
    (fetchGoogleAccountEmail as ReturnType<typeof vi.fn>).mockResolvedValue("me@x.com");
    const cb = vi.fn();
    await depositOAuthCredential(
      makeCall({
        provider: "google",
        userId: "u1",
        accessToken: "at",
        refreshToken: "rt",
        expiresAt: 123,
        scopes: "calendar",
        metadata: {},
      }),
      cb,
    );
    // The Google MCP builder reads google:{userId}:{email} via storeGoogleAccount;
    // the generic provider:userId upsert (invisible to it) must NOT be used.
    expect(storeGoogleAccount).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "u1",
        email: "me@x.com",
        tokens: expect.objectContaining({ accessToken: "at", refreshToken: "rt", expiresAt: 123 }),
      }),
    );
    expect(upsertIntegration).not.toHaveBeenCalled();
    expect(cb).toHaveBeenCalledWith(null, expect.objectContaining({ success: true }));
  });

  it("fails the google deposit when the email can't be resolved (no broken row)", async () => {
    (fetchGoogleAccountEmail as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    const cb = vi.fn();
    await depositOAuthCredential(
      makeCall({
        provider: "google",
        userId: "u1",
        accessToken: "at",
        refreshToken: "",
        expiresAt: 0,
        scopes: "",
        metadata: {},
      }),
      cb,
    );
    expect(storeGoogleAccount).not.toHaveBeenCalled();
    expect(upsertIntegration).not.toHaveBeenCalled();
    expect(cb).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("email") }),
    );
  });

  it("writes a generic provider:userId row for non-google providers", async () => {
    const cb = vi.fn();
    await depositOAuthCredential(
      makeCall({
        provider: "slack",
        userId: "u1",
        accessToken: "at",
        refreshToken: "rt",
        expiresAt: 1,
        scopes: "chat:write",
        metadata: {},
      }),
      cb,
    );
    expect(upsertIntegration).toHaveBeenCalledWith(
      "slack:u1",
      expect.objectContaining({
        enabled: true,
        secrets: expect.objectContaining({ access_token: "at" }),
      }),
    );
    expect(storeGoogleAccount).not.toHaveBeenCalled();
    expect(cb).toHaveBeenCalledWith(null, expect.objectContaining({ success: true }));
  });
});
