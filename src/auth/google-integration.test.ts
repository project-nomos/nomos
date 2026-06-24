import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildAuthUrl,
  GOOGLE_SCOPES,
  GOOGLE_CLASSROOM_SCOPES_READ,
  GOOGLE_CLASSROOM_SCOPES_WRITE,
  googleClientCreds,
  googleRedirectUriForPlatform,
  hasClassroomScope,
  hasClassroomWriteScope,
  isSchoolAccount,
  isGoogleIntegrationConfigured,
  signOAuthState,
  verifyOAuthState,
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
    // send is the load-bearing capability the REST server adds
    expect(scope).toContain("https://www.googleapis.com/auth/gmail.send");
    expect(scope).toContain("https://www.googleapis.com/auth/calendar");
    expect(scope).toContain("https://www.googleapis.com/auth/drive.file");
  });
});

describe("Classroom scopes", () => {
  it("keeps Classroom scopes OUT of the base scope set (non-students never asked)", () => {
    expect(GOOGLE_SCOPES.some((s) => s.includes("classroom"))).toBe(false);
  });

  it("buildAuthUrl omits Classroom scopes by default", () => {
    vi.stubEnv("GOOGLE_CLIENT_ID", "cid.apps.googleusercontent.com");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "secret");
    const url = new URL(buildAuthUrl({ redirectUri: "http://x/cb", state: "s" }));
    expect(url.searchParams.get("scope") ?? "").not.toContain("classroom");
  });

  it("buildAuthUrl appends read scopes for classroom='read'", () => {
    vi.stubEnv("GOOGLE_CLIENT_ID", "cid.apps.googleusercontent.com");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "secret");
    const scope =
      new URL(
        buildAuthUrl({ redirectUri: "http://x/cb", state: "s", classroom: "read" }),
      ).searchParams.get("scope") ?? "";
    expect(scope).toContain("classroom.courses.readonly");
    expect(scope).toContain("classroom.coursework.me.readonly");
    expect(scope).not.toContain("auth/classroom.coursework.me ");
  });

  it("buildAuthUrl appends the read-write coursework scope for classroom='write'", () => {
    vi.stubEnv("GOOGLE_CLIENT_ID", "cid.apps.googleusercontent.com");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "secret");
    const scope =
      new URL(
        buildAuthUrl({ redirectUri: "http://x/cb", state: "s", classroom: "write" }),
      ).searchParams.get("scope") ?? "";
    expect(scope).toContain("https://www.googleapis.com/auth/classroom.coursework.me");
    expect(scope).not.toContain("classroom.coursework.me.readonly");
    // Turn-in needs drive.file (submission Doc).
    expect(scope).toContain("https://www.googleapis.com/auth/drive.file");
  });

  it("a Classroom connect is classroom-ONLY (no Gmail/Calendar) so it can target a separate account", () => {
    vi.stubEnv("GOOGLE_CLIENT_ID", "cid.apps.googleusercontent.com");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "secret");
    for (const classroom of ["read", "write"] as const) {
      const url = new URL(buildAuthUrl({ redirectUri: "http://x/cb", state: "s", classroom }));
      const scope = url.searchParams.get("scope") ?? "";
      // No Gmail/Calendar on the classroom grant — keeps the school account separate.
      expect(scope).not.toContain("gmail");
      expect(scope).not.toContain("calendar");
      // Force the account chooser so the student can pick a different (school) account.
      expect(url.searchParams.get("prompt")).toBe("select_account consent");
      // Still carries identity so the daemon can resolve the account email.
      expect(scope).toContain("openid");
    }
  });

  it("treats only EDUCATIONAL domains as school accounts (Classroom gate)", () => {
    // Schools / universities — yes.
    expect(isSchoolAccount("kid@mit.edu")).toBe(true);
    expect(isSchoolAccount("student@lincoln.k12.ca.us")).toBe(true);
    expect(isSchoolAccount("s@school.edu.au")).toBe(true);
    expect(isSchoolAccount("s@oxford.ac.uk")).toBe(true);
    // Personal AND business accounts — no (a business is not a school).
    expect(isSchoolAccount("me@gmail.com")).toBe(false);
    expect(isSchoolAccount("me@googlemail.com")).toBe(false);
    expect(isSchoolAccount("worker@acme.com")).toBe(false);
    expect(isSchoolAccount("worker@bigco.org")).toBe(false);
    expect(isSchoolAccount("")).toBe(false);
  });

  it("detects classroom + write scopes in a granted-scopes string", () => {
    const read = GOOGLE_CLASSROOM_SCOPES_READ.join(" ");
    const write = GOOGLE_CLASSROOM_SCOPES_WRITE.join(" ");
    expect(hasClassroomScope(read)).toBe(true);
    expect(hasClassroomScope("openid email")).toBe(false);
    expect(hasClassroomWriteScope(read)).toBe(false); // read-only coursework scope
    expect(hasClassroomWriteScope(write)).toBe(true);
  });
});

describe("googleRedirectUriForPlatform", () => {
  it("mobile gets the nomos:// relay redirect; web gets the default", () => {
    vi.stubEnv("GOOGLE_OAUTH_REDIRECT_URI", "https://web/oauth/google/callback");
    vi.stubEnv("GOOGLE_OAUTH_MOBILE_REDIRECT_URI", "https://auth/oauth/google/relay");
    expect(googleRedirectUriForPlatform("mobile")).toBe("https://auth/oauth/google/relay");
    expect(googleRedirectUriForPlatform("")).toBe("https://web/oauth/google/callback");
    expect(googleRedirectUriForPlatform(undefined)).toBe("https://web/oauth/google/callback");
  });
});

describe("OAuth CSRF state", () => {
  // State signing fails closed without a secret (no hardcoded fallback), so provide one.
  beforeEach(() => vi.stubEnv("ENCRYPTION_KEY", "test-encryption-key-0123456789abcdef"));
  afterEach(() => vi.unstubAllEnvs());

  it("round-trips for the same user", () => {
    const s = signOAuthState("user-A");
    expect(verifyOAuthState(s, "user-A")).toBe(true);
  });

  it("rejects a different user", () => {
    const s = signOAuthState("user-A");
    expect(verifyOAuthState(s, "user-B")).toBe(false);
  });

  it("rejects a tampered signature", () => {
    const s = signOAuthState("user-A");
    expect(verifyOAuthState(s.slice(0, -2) + "xy", "user-A")).toBe(false);
  });

  it("rejects an expired state", () => {
    const s = signOAuthState("user-A", -1); // already expired
    expect(verifyOAuthState(s, "user-A")).toBe(false);
  });

  it("rejects garbage", () => {
    expect(verifyOAuthState("not-a-state", "user-A")).toBe(false);
    expect(verifyOAuthState("", "user-A")).toBe(false);
  });
});

describe("constants", () => {
  it("includes identity scopes so the account email is readable", () => {
    expect(GOOGLE_SCOPES).toContain("openid");
    expect(GOOGLE_SCOPES).toContain("email");
  });
});
