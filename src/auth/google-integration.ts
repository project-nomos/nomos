/**
 * Google Workspace integration for HOSTED mode — owned entirely by the daemon,
 * decoupled from nomos-server's Better Auth (which handles login/identity only).
 *
 * The daemon holds the central Google OAuth client creds (GOOGLE_CLIENT_ID /
 * GOOGLE_CLIENT_SECRET, from .env in dev or a K8s secret in prod) and runs the
 * whole integration lifecycle itself: build the consent URL, exchange the code,
 * store + refresh per-account tokens, and hand a valid access token to the
 * Google remote MCP servers (gmail/calendar/drive) at agent time.
 *
 * Multi-account: each connected Google account is its own integrations row
 * (`google:<userId>:<email>`), so a user can connect work + personal and the
 * agent uses the right account's token per MCP call.
 *
 * Power-user mode keeps the `gws` CLI path (see google-workspace-mcp.ts); this
 * module is only used when isHosted().
 */

import { createLogger } from "../lib/logger.ts";
import {
  getIntegration,
  listIntegrationsByPrefix,
  removeIntegration,
  upsertIntegration,
  type Integration,
} from "../db/integrations.ts";

const log = createLogger("google-integration");

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

/**
 * Scopes for the hosted Google connect flow. Exactly what the Google Workspace
 * remote MCP servers validate, plus calendar.events / drive.file for the write
 * tools and openid/email/profile so we can read the account email. One grant
 * covers Gmail + Calendar + Drive.
 */
export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "profile",
  // Gmail
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
  // Calendar
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "https://www.googleapis.com/auth/calendar.events.freebusy",
  "https://www.googleapis.com/auth/calendar.events.readonly",
  "https://www.googleapis.com/auth/calendar.events",
  // Drive
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/drive.file",
];

/** Remote MCP server endpoints (Google Workspace Developer Preview). */
export const GOOGLE_MCP_ENDPOINTS = {
  gmail: "https://gmailmcp.googleapis.com/mcp/v1",
  calendar: "https://calendarmcp.googleapis.com/mcp/v1",
  drive: "https://drivemcp.googleapis.com/mcp/v1",
} as const;

export type GoogleMcpService = keyof typeof GOOGLE_MCP_ENDPOINTS;

export interface GoogleAccount {
  /** BA user this account belongs to. */
  userId: string;
  /** The connected Google account email (the multi-account key). */
  email: string;
  /** Space-separated granted scopes. */
  scopes: string;
  /** Whether this is the user's default Google account. */
  isDefault: boolean;
  /** Unix seconds when the current access token expires. */
  expiresAt: number;
}

interface GoogleTokens {
  accessToken: string;
  refreshToken?: string;
  /** Unix seconds. */
  expiresAt: number;
  scope?: string;
}

/** Central Google OAuth client creds. Throws if unconfigured. */
export function googleClientCreds(): { clientId: string; clientSecret: string } {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      "Google integration requires GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (.env in dev, K8s secret in prod)",
    );
  }
  return { clientId, clientSecret };
}

/** True if the daemon has Google client creds configured at all. */
export function isGoogleIntegrationConfigured(): boolean {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

function integrationName(userId: string, email: string): string {
  return `google:${userId}:${email.toLowerCase()}`;
}

// ── OAuth: build consent URL ──

/**
 * Build the Google consent URL for a connect flow. `state` is round-tripped to
 * the callback for CSRF protection (verify it matches before exchanging the
 * code). `redirectUri` MUST match what the callback uses for the exchange.
 */
export function buildAuthUrl(opts: {
  redirectUri: string;
  state: string;
  loginHint?: string;
}): string {
  const { clientId } = googleClientCreds();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: opts.redirectUri,
    response_type: "code",
    scope: GOOGLE_SCOPES.join(" "),
    // offline + consent → Google returns a refresh token even on re-connect.
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state: opts.state,
  });
  if (opts.loginHint) params.set("login_hint", opts.loginHint);
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

// ── OAuth: token endpoint calls ──

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
  id_token?: string;
  error?: string;
  error_description?: string;
}

async function postToken(body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  const json = (await res.json()) as TokenResponse;
  if (!res.ok || json.error) {
    throw new Error(
      `Google token endpoint error: ${json.error ?? res.status} ${json.error_description ?? ""}`.trim(),
    );
  }
  return json;
}

/** Decode (without verifying) the email claim from a Google id_token. */
function emailFromIdToken(idToken: string | undefined): string | undefined {
  if (!idToken) return undefined;
  const payload = idToken.split(".")[1];
  if (!payload) return undefined;
  try {
    const json = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      email?: string;
    };
    return json.email?.toLowerCase();
  } catch {
    return undefined;
  }
}

/** Exchange an authorization code for tokens + the account email. */
export async function exchangeCode(opts: {
  code: string;
  redirectUri: string;
}): Promise<GoogleTokens & { email: string }> {
  const { clientId, clientSecret } = googleClientCreds();
  const t = await postToken({
    grant_type: "authorization_code",
    code: opts.code,
    redirect_uri: opts.redirectUri,
    client_id: clientId,
    client_secret: clientSecret,
  });
  const email = emailFromIdToken(t.id_token);
  if (!email) throw new Error("Google connect: could not determine account email from id_token");
  if (!t.refresh_token) {
    // Without offline access / first consent Google omits the refresh token,
    // leaving us unable to refresh. buildAuthUrl forces prompt=consent to avoid
    // this, so surface it loudly if it still happens.
    log.warn(
      { email },
      "Google connect returned no refresh_token — re-consent with prompt=consent",
    );
  }
  return {
    accessToken: t.access_token,
    refreshToken: t.refresh_token,
    expiresAt: Math.floor(Date.now() / 1000) + t.expires_in,
    scope: t.scope,
    email,
  };
}

/** Refresh an access token. Google may omit a new refresh_token (reuse the old). */
async function refreshAccessToken(refreshToken: string): Promise<GoogleTokens> {
  const { clientId, clientSecret } = googleClientCreds();
  const t = await postToken({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });
  return {
    accessToken: t.access_token,
    refreshToken: t.refresh_token ?? refreshToken,
    expiresAt: Math.floor(Date.now() / 1000) + t.expires_in,
    scope: t.scope,
  };
}

// ── storage (per-account integrations rows) ──

/** Persist a connected Google account. First account for a user becomes default. */
export async function storeGoogleAccount(opts: {
  userId: string;
  email: string;
  tokens: GoogleTokens;
  scopes: string;
}): Promise<void> {
  const existing = await listGoogleAccounts(opts.userId);
  const isDefault =
    existing.length === 0 || existing.some((a) => a.email === opts.email && a.isDefault);
  await upsertIntegration(integrationName(opts.userId, opts.email), {
    enabled: true,
    config: {
      provider: "google",
      user_id: opts.userId,
      account_email: opts.email,
      scopes: opts.scopes,
      is_default: isDefault,
    },
    secrets: {
      access_token: opts.tokens.accessToken,
      refresh_token: opts.tokens.refreshToken ?? "",
      expires_at: String(opts.tokens.expiresAt),
    },
    metadata: { connected_at: new Date().toISOString() },
  });
  log.info({ userId: opts.userId, email: opts.email, isDefault }, "stored Google account");
}

function rowToAccount(i: Integration): GoogleAccount {
  return {
    userId: String(i.config.user_id ?? ""),
    email: String(i.config.account_email ?? ""),
    scopes: String(i.config.scopes ?? ""),
    isDefault: Boolean(i.config.is_default),
    expiresAt: Number(i.secrets.expires_at ?? 0),
  };
}

/** List a user's connected Google accounts. */
export async function listGoogleAccounts(userId: string): Promise<GoogleAccount[]> {
  const rows = await listIntegrationsByPrefix(`google:${userId}:`);
  return rows.filter((r) => r.enabled).map(rowToAccount);
}

/** Disconnect one Google account. */
export async function removeGoogleAccount(userId: string, email: string): Promise<void> {
  await removeIntegration(integrationName(userId, email));
  log.info({ userId, email }, "removed Google account");
}

/**
 * Return a valid access token for a user's Google account, refreshing it (and
 * persisting the new token) when it's within 60s of expiry. If `email` is
 * omitted, uses the default account.
 */
export async function getValidAccessToken(userId: string, email?: string): Promise<string | null> {
  let name: string;
  if (email) {
    name = integrationName(userId, email);
  } else {
    const accounts = await listGoogleAccounts(userId);
    const def = accounts.find((a) => a.isDefault) ?? accounts[0];
    if (!def) return null;
    name = integrationName(userId, def.email);
  }

  const integ = await getIntegration(name);
  if (!integ || !integ.enabled) return null;

  const accessToken = integ.secrets.access_token;
  const refreshToken = integ.secrets.refresh_token;
  const expiresAt = Number(integ.secrets.expires_at ?? 0);
  const nowSec = Math.floor(Date.now() / 1000);

  if (accessToken && expiresAt - 60 > nowSec) {
    return accessToken; // still valid
  }
  if (!refreshToken) {
    log.warn({ name }, "Google access token expired and no refresh token — needs re-connect");
    return accessToken || null;
  }

  try {
    const refreshed = await refreshAccessToken(refreshToken);
    await upsertIntegration(name, {
      secrets: {
        access_token: refreshed.accessToken,
        refresh_token: refreshed.refreshToken ?? refreshToken,
        expires_at: String(refreshed.expiresAt),
      },
    });
    return refreshed.accessToken;
  } catch (err) {
    log.error(
      { name, err: err instanceof Error ? err.message : err },
      "Google token refresh failed",
    );
    return null;
  }
}
