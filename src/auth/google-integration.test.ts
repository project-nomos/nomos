import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildAuthUrl,
  GOOGLE_MCP_ENDPOINTS,
  GOOGLE_SCOPES,
  googleClientCreds,
  isGoogleIntegrationConfigured,
} from "./google-integration.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("googleClientCreds", () => {
  it("throws when client creds are missing", () => {
    vi.stubEnv("GOOGLE_CLIENT_ID", "");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "");
    expect(() => googleClientCreds()).toThrow(/GOOGLE_CLIENT_ID/);
    expect(isGoogleIntegrationConfigured()).toBe(false);
  });

  it("returns creds when configured", () => {
    vi.stubEnv("GOOGLE_CLIENT_ID", "cid.apps.googleusercontent.com");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "secret");
    expect(googleClientCreds()).toEqual({
      clientId: "cid.apps.googleusercontent.com",
      clientSecret: "secret",
    });
    expect(isGoogleIntegrationConfigured()).toBe(true);
  });
});

describe("buildAuthUrl", () => {
  it("requests offline access + consent and all Gmail/Calendar/Drive scopes", () => {
    vi.stubEnv("GOOGLE_CLIENT_ID", "cid.apps.googleusercontent.com");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "secret");

    const url = new URL(
      buildAuthUrl({
        redirectUri: "http://localhost:4100/oauth/google/callback",
        state: "nonce123",
      }),
    );

    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe("cid.apps.googleusercontent.com");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "http://localhost:4100/oauth/google/callback",
    );
    expect(url.searchParams.get("response_type")).toBe("code");
    // refresh-token-critical params
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("state")).toBe("nonce123");

    const scope = url.searchParams.get("scope") ?? "";
    expect(scope).toContain("https://www.googleapis.com/auth/gmail.readonly");
    expect(scope).toContain("https://www.googleapis.com/auth/gmail.compose");
    expect(scope).toContain("https://www.googleapis.com/auth/calendar.events");
    expect(scope).toContain("https://www.googleapis.com/auth/drive.file");
  });
});

describe("constants", () => {
  it("exposes the three Developer-Preview remote MCP endpoints", () => {
    expect(GOOGLE_MCP_ENDPOINTS.gmail).toBe("https://gmailmcp.googleapis.com/mcp/v1");
    expect(GOOGLE_MCP_ENDPOINTS.calendar).toBe("https://calendarmcp.googleapis.com/mcp/v1");
    expect(GOOGLE_MCP_ENDPOINTS.drive).toBe("https://drivemcp.googleapis.com/mcp/v1");
  });

  it("includes identity scopes so the account email is readable", () => {
    expect(GOOGLE_SCOPES).toContain("openid");
    expect(GOOGLE_SCOPES).toContain("email");
  });
});
