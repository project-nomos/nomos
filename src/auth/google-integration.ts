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

import { createHmac, timingSafeEqual } from "node:crypto";
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
 * Scopes for the Google connect flow. Hosted uses Google's official remote MCP
 * servers, so these match exactly what those servers validate (gmail.readonly +
 * gmail.compose, the granular calendar scopes, drive.readonly + drive.file) —
 * PLUS gmail.send + calendar.events, which the official Gmail MCP doesn't grant:
 * sending is done by our own opt-in API tool, and calendar writes need events.
 *
 * Deliberately NOT gmail.modify (a restricted scope needing CASA review).
 */
export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "profile",
  // Gmail — read + draft (official MCP) + send (our opt-in API tool)
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/gmail.send",
  // Calendar — official MCP's granular read scopes + events (write)
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "https://www.googleapis.com/auth/calendar.events.freebusy",
  "https://www.googleapis.com/auth/calendar.events.readonly",
  "https://www.googleapis.com/auth/calendar.events",
  // Drive — read all + create/upload
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/drive.file",
];

export interface GoogleAccount {
  /** BA user this account belongs to. */
  userId: string;
  /** The connected Google account email (the multi-account key). */
  email: string;
  /** Space-separated granted scopes. */
  scopes: string;
  /** Whether this is the user's default Google account. */
  isDefault: boolean;
  /**
   * Whether the agent may SEND email from this account. Off by default: the
   * agent drafts and the user approves/sends, unless explicitly enabled.
   */
  sendEnabled: boolean;
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

/**
 * Redirect URI for the connect flow. MUST exactly match an authorized redirect
 * URI on the OAuth client AND the route that relays the code back to the daemon
 * (the web client / mobile callback). Used by both buildAuthUrl and exchangeCode.
 */
export function googleRedirectUri(): string {
  return process.env.GOOGLE_OAUTH_REDIRECT_URI ?? "http://localhost:4100/oauth/google/callback";
}

function oauthStateSecret(): string {
  return (
    process.env.ENCRYPTION_KEY ?? process.env.GOOGLE_CLIENT_SECRET ?? "nomos-google-oauth-state"
  );
}

/**
 * Sign a CSRF `state` binding the connecting user + an expiry. Stateless (HMAC),
 * so it survives across stateless pods — the callback verifies it before
 * exchanging the code, and the user identity still comes from the JWT.
 */
export function signOAuthState(userId: string, ttlSeconds = 600): string {
  const payload = `${userId}.${Math.floor(Date.now() / 1000) + ttlSeconds}`;
  const sig = createHmac("sha256", oauthStateSecret()).update(payload).digest("base64url");
  return `${Buffer.from(payload).toString("base64url")}.${sig}`;
}

/** Verify a signed state belongs to `userId` and hasn't expired. */
export function verifyOAuthState(state: string, userId: string): boolean {
  const dot = state.lastIndexOf(".");
  if (dot < 0) return false;
  let payload: string;
  try {
    payload = Buffer.from(state.slice(0, dot), "base64url").toString("utf8");
  } catch {
    return false;
  }
  const expected = createHmac("sha256", oauthStateSecret()).update(payload).digest("base64url");
  const got = Buffer.from(state.slice(dot + 1));
  const exp = Buffer.from(expected);
  if (got.length !== exp.length || !timingSafeEqual(got, exp)) return false;
  const [uid, expStr] = payload.split(".");
  return uid === userId && Number(expStr) >= Math.floor(Date.now() / 1000);
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

/**
 * Resolve a Google account's email from an access token via the OpenID userinfo
 * endpoint. Used by the OAuth deposit path (mTLS handoff carries the token but no
 * id_token / email), so the account can be stored under `google:{userId}:{email}`.
 */
export async function fetchGoogleAccountEmail(accessToken: string): Promise<string | undefined> {
  try {
    const res = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return undefined;
    const data = (await res.json()) as { email?: string };
    return data.email?.toLowerCase();
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
  const prev = existing.find((a) => a.email.toLowerCase() === opts.email.toLowerCase());
  const isDefault = existing.length === 0 || Boolean(prev?.isDefault);
  await upsertIntegration(integrationName(opts.userId, opts.email), {
    enabled: true,
    config: {
      provider: "google",
      user_id: opts.userId,
      account_email: opts.email,
      scopes: opts.scopes,
      is_default: isDefault,
      // Preserve the send toggle across re-connects (default off).
      send_enabled: prev?.sendEnabled ?? false,
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
    sendEnabled: Boolean(i.config.send_enabled),
    expiresAt: Number(i.secrets.expires_at ?? 0),
  };
}

/** List a user's connected Google accounts. */
export async function listGoogleAccounts(userId: string): Promise<GoogleAccount[]> {
  const rows = await listIntegrationsByPrefix(`google:${userId}:`);
  return rows.filter((r) => r.enabled).map(rowToAccount);
}

/**
 * Enable/disable the agent sending email from a Google account. Off by default
 * (draft-only). The Settings UI / a connect flow flips this per account.
 */
export async function setSendEnabled(
  userId: string,
  email: string,
  enabled: boolean,
): Promise<void> {
  const name = integrationName(userId, email);
  const integ = await getIntegration(name);
  if (!integ) throw new Error(`No connected Google account ${email} for this user`);
  await upsertIntegration(name, { config: { ...integ.config, send_enabled: enabled } });
  log.info({ userId, email, enabled }, "set Google send_enabled");
}

/** Whether sending is enabled for a user's account (default account if omitted). */
export async function isSendEnabled(userId: string, email?: string): Promise<boolean> {
  const accounts = await listGoogleAccounts(userId);
  const acct = email
    ? accounts.find((a) => a.email.toLowerCase() === email.toLowerCase())
    : (accounts.find((a) => a.isDefault) ?? accounts[0]);
  return Boolean(acct?.sendEnabled);
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
