/**
 * JWT validator. Verifies tokens issued by the central Better Auth server.
 *
 * Hosted mode flow:
 *   1. Mobile/web client signs in via BA → gets a short-lived JWT.
 *   2. Client sends `Authorization: Bearer <jwt>` on every gRPC call.
 *   3. This validator fetches BA's JWKS endpoint (cached for 1h) and
 *      verifies the signature, exp, and `org_id` claim.
 *   4. Returns a TenantContext attached to the call.
 *
 * Power-user mode: validator is a no-op when AUTH_JWKS_URL is unset; the
 * synthetic LOCAL_TENANT is used everywhere.
 */

import { createPublicKey, KeyObject, verify } from "node:crypto";
import { Buffer } from "node:buffer";
import { createLogger } from "../lib/logger.ts";
import type { TenantContext } from "./tenant-context.ts";

const log = createLogger("jwt-validator");

const JWKS_CACHE_TTL_MS = 60 * 60 * 1000; // 1h

interface Jwk {
  kid: string;
  kty: string;
  crv?: string;
  x?: string;
  alg?: string;
  use?: string;
}

interface JwksDocument {
  keys: Jwk[];
}

interface JwksCache {
  fetchedAt: number;
  document: JwksDocument;
  keys: Map<string, KeyObject>;
}

let cache: JwksCache | null = null;
let inflightFetch: Promise<JwksCache> | null = null;

interface JwtClaims {
  sub: string;
  org_id?: string | null;
  email?: string;
  exp: number;
  iat?: number;
  iss?: string;
  aud?: string | string[];
}

export class JwtValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JwtValidationError";
  }
}

function decodeBase64Url(value: string): Buffer {
  // Base64url → standard base64 (replace -_ and pad).
  const padded = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(value.length + ((4 - (value.length % 4)) % 4), "=");
  return Buffer.from(padded, "base64");
}

function decodeJwtParts(token: string): {
  header: Record<string, unknown>;
  payload: JwtClaims;
  signature: Buffer;
  signed: Buffer;
} {
  const parts = token.split(".");
  if (parts.length !== 3) throw new JwtValidationError("malformed_jwt");
  const [h, p, s] = parts;
  const headerBytes = decodeBase64Url(h);
  const payloadBytes = decodeBase64Url(p);
  const sigBytes = decodeBase64Url(s);

  let header: Record<string, unknown>;
  let payload: JwtClaims;
  try {
    header = JSON.parse(headerBytes.toString("utf-8")) as Record<string, unknown>;
    payload = JSON.parse(payloadBytes.toString("utf-8")) as JwtClaims;
  } catch {
    throw new JwtValidationError("bad_json");
  }

  // The signed input is the header + "." + payload, in their original
  // base64url-encoded form (not the decoded bytes).
  const signed = Buffer.from(`${h}.${p}`, "utf-8");
  return { header, payload, signature: sigBytes, signed };
}

async function fetchJwks(url: string): Promise<JwksCache> {
  const r = await fetch(url);
  if (!r.ok) throw new JwtValidationError(`jwks_fetch_failed:${r.status}`);
  const doc = (await r.json()) as JwksDocument;
  const keys = new Map<string, KeyObject>();
  for (const k of doc.keys) {
    try {
      // Better Auth issues EdDSA Ed25519 keys by default. Cast through unknown
      // since `Jwk` in this file is a narrow subset of the broader JsonWebKey.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pem = createPublicKey({ key: k, format: "jwk" } as any);
      keys.set(k.kid, pem);
    } catch (err) {
      log.warn({ err, kid: k.kid }, "Skipping unparseable JWK");
    }
  }
  return { fetchedAt: Date.now(), document: doc, keys };
}

async function getKeys(): Promise<JwksCache> {
  const url = process.env.AUTH_JWKS_URL;
  if (!url) throw new JwtValidationError("auth_jwks_url_not_set");

  if (cache && Date.now() - cache.fetchedAt < JWKS_CACHE_TTL_MS) {
    return cache;
  }
  if (inflightFetch) return inflightFetch;
  inflightFetch = fetchJwks(url)
    .then((c) => {
      cache = c;
      return c;
    })
    .finally(() => {
      inflightFetch = null;
    });
  return inflightFetch;
}

export async function refreshJwks(): Promise<void> {
  cache = null;
  await getKeys();
}

/**
 * Verify a JWT and return a TenantContext built from its claims.
 *
 * Zero-trust checks performed:
 *   - signature valid against current JWKS
 *   - exp not in the past
 *   - org_id claim matches NOMOS_ORG_ID env (rejects cross-org tokens that
 *     somehow landed on the wrong instance)
 *
 * The caller is responsible for checking that the resolved user_id is a
 * current member of the org via the org_members table (done by the gRPC
 * interceptor so this function stays pure / sync-safe).
 */
export async function verifyJwt(token: string): Promise<TenantContext> {
  const { header, payload, signature, signed } = decodeJwtParts(token);
  const kid = header.kid as string | undefined;
  const alg = header.alg as string | undefined;

  if (alg !== "EdDSA") {
    throw new JwtValidationError(`unsupported_alg:${alg ?? "missing"}`);
  }
  if (!kid) throw new JwtValidationError("missing_kid");

  const jwks = await getKeys();
  let key = jwks.keys.get(kid);
  if (!key) {
    // Possible key rotation — refresh once and retry.
    cache = null;
    const refreshed = await getKeys();
    key = refreshed.keys.get(kid);
  }
  if (!key) throw new JwtValidationError(`unknown_kid:${kid}`);

  const ok = verify(null, signed, key, signature);
  if (!ok) throw new JwtValidationError("bad_signature");

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || payload.exp < now) {
    throw new JwtValidationError("expired");
  }
  if (!payload.sub) throw new JwtValidationError("missing_sub");

  const expectedOrgId = process.env.NOMOS_ORG_ID;
  if (expectedOrgId) {
    if (!payload.org_id || payload.org_id !== expectedOrgId) {
      throw new JwtValidationError("org_id_mismatch");
    }
  }

  return {
    orgId: payload.org_id ?? expectedOrgId ?? "local",
    userId: payload.sub,
  };
}
