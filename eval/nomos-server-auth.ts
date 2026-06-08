/**
 * Real-token bridge to nomos-server (the central Better Auth issuer).
 *
 * Unlike eval/hosted-auth.ts (which mints its own JWTs against a self-served
 * JWKS), this obtains a JWT the way a real client does: sign up / sign in, pin an
 * active organization so the token carries org_id, then mint via the Better Auth
 * jwt plugin. The daemon then verifies it against nomos-server's live JWKS. This
 * exercises the actual issuance path, so it requires nomos-server running on :4000.
 *
 * Returns null when the server is not reachable, so the eval can skip gracefully.
 */

import { Buffer } from "node:buffer";

const SERVER = process.env.NOMOS_SERVER_URL ?? "http://localhost:4000";
const EMAIL = process.env.NOMOS_EVAL_EMAIL ?? "eval-mobile@nomos.local";
const PASSWORD = process.env.NOMOS_EVAL_PASSWORD ?? "evalpass12345";

export interface RealAuth {
  token: string;
  userId: string;
  orgId: string;
  serverUrl: string;
}

/** True when nomos-server is up and its JWKS endpoint is serving keys. */
export async function detectNomosServer(): Promise<boolean> {
  try {
    const r = await fetch(`${SERVER}/api/auth/jwks`, { signal: AbortSignal.timeout(2500) });
    if (!r.ok) return false;
    const doc = (await r.json()) as { keys?: unknown[] };
    return Array.isArray(doc.keys) && doc.keys.length > 0;
  } catch {
    return false;
  }
}

function collectCookies(res: Response, jar: Map<string, string>): void {
  for (const sc of res.headers.getSetCookie?.() ?? []) {
    const pair = sc.split(";", 1)[0];
    const eq = pair.indexOf("=");
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}
function cookieHeader(jar: Map<string, string>): string {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

function decodeJwtPayload(token: string): { sub?: string; org_id?: string } {
  const part = token.split(".")[1] ?? "";
  const json = Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
  return JSON.parse(json) as { sub?: string; org_id?: string };
}

/**
 * Sign up (or sign in) a fixed eval user, pin its personal org, and mint a JWT.
 * Returns the token plus the sub/org_id the daemon will see, or null if the
 * server is unreachable or the flow fails.
 */
export async function provisionRealUser(): Promise<RealAuth | null> {
  if (!(await detectNomosServer())) return null;
  const origin = SERVER;
  const jar = new Map<string, string>();

  // Better Auth's emailAndPassword (autoSignIn) sets the session cookie on sign-up;
  // on a repeat run the user exists, so fall back to sign-in.
  let res = await fetch(`${SERVER}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ name: "Eval Mobile", email: EMAIL, password: PASSWORD }),
  });
  collectCookies(res, jar);
  if (!res.ok || jar.size === 0) {
    res = await fetch(`${SERVER}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    collectCookies(res, jar);
    if (!res.ok) return null;
  }
  let cookie = cookieHeader(jar);

  // Pin the active org so the JWT carries org_id (the daemon rejects a null org_id
  // when NOMOS_ORG_ID is set). The session-create hook already made a personal org.
  const orgsRes = await fetch(`${SERVER}/api/auth/organization/list`, {
    headers: { origin, cookie },
  });
  const orgs = orgsRes.ok ? ((await orgsRes.json()) as { id: string }[]) : [];
  const orgId = Array.isArray(orgs) && orgs[0]?.id;
  if (!orgId) return null;
  const setActive = await fetch(`${SERVER}/api/auth/organization/set-active`, {
    method: "POST",
    headers: { "content-type": "application/json", origin, cookie },
    body: JSON.stringify({ organizationId: orgId }),
  });
  collectCookies(setActive, jar);
  cookie = cookieHeader(jar);

  // Mint the JWT (jwt plugin); fall back to the set-auth-jwt session header.
  let token = "";
  const tokenRes = await fetch(`${SERVER}/api/auth/token`, { headers: { origin, cookie } });
  if (tokenRes.ok) token = ((await tokenRes.json()) as { token?: string }).token ?? "";
  if (!token) {
    const sess = await fetch(`${SERVER}/api/auth/get-session`, { headers: { origin, cookie } });
    token = sess.headers.get("set-auth-jwt") ?? "";
  }
  if (!token) return null;

  const payload = decodeJwtPayload(token);
  if (!payload.sub) return null;
  return { token, userId: payload.sub, orgId: payload.org_id ?? orgId, serverUrl: SERVER };
}
