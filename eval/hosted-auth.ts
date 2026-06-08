/**
 * Hosted-auth harness for the eval.
 *
 * The daemon verifies tokens issued by the central Better Auth server: header
 * alg MUST be EdDSA, a kid that resolves against a JWKS fetched (real HTTP) from
 * AUTH_JWKS_URL, and claims sub (-> userId) + org_id (== NOMOS_ORG_ID) + exp.
 * This mints exactly such tokens with node:crypto (no jose dependency) and serves
 * a matching JWKS, so the eval can drive the hosted, authenticated wire end to end.
 *
 * Calling startHostedAuth flips the process into hosted mode (NOMOS_MODE +
 * AUTH_JWKS_URL + NOMOS_ORG_ID); stop() reverts it and tears the server down.
 */

import { createServer, type Server } from "node:http";
import { generateKeyPairSync, sign } from "node:crypto";
import { Buffer } from "node:buffer";
import { refreshJwks } from "../src/auth/jwt-validator.ts";

const KID = "eval-key-1";

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export interface HostedAuth {
  /** Mint a bearer JWT for a tenant. The validator maps sub -> userId. */
  mint: (userId: string) => string;
  /** Revert hosted-mode env vars and stop the JWKS server. */
  stop: () => Promise<void>;
}

export async function startHostedAuth(orgId: string): Promise<HostedAuth> {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  // publicKey.export({format:"jwk"}) yields {kty:"OKP",crv:"Ed25519",x:...}; the
  // validator passes the whole JWK to createPublicKey, so kty/crv/x + kid are what
  // matter. Never serve the private (d) field.
  const jwk = {
    ...(publicKey.export({ format: "jwk" }) as Record<string, unknown>),
    kid: KID,
    alg: "EdDSA",
    use: "sig",
  };

  const server = await new Promise<Server>((resolve) => {
    const s = createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ keys: [jwk] }));
    });
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;

  process.env.NOMOS_MODE = "hosted";
  process.env.NOMOS_ORG_ID = orgId;
  process.env.AUTH_JWKS_URL = `http://127.0.0.1:${port}/jwks.json`;
  // Bust the validator's 1h JWKS cache so a stale keyset from a prior run is not reused.
  await refreshJwks().catch(() => {});

  function mint(userId: string): string {
    const header = { alg: "EdDSA", kid: KID, typ: "JWT" };
    const payload = { sub: userId, org_id: orgId, exp: Math.floor(Date.now() / 1000) + 3600 };
    const signingInput =
      base64url(Buffer.from(JSON.stringify(header))) +
      "." +
      base64url(Buffer.from(JSON.stringify(payload)));
    const signature = sign(null, Buffer.from(signingInput), privateKey);
    return signingInput + "." + base64url(signature);
  }

  async function stop(): Promise<void> {
    delete process.env.NOMOS_MODE;
    delete process.env.NOMOS_ORG_ID;
    delete process.env.AUTH_JWKS_URL;
    // refreshJwks now throws auth_jwks_url_not_set (URL unset); it still nulls the
    // cache first, which is the point. Swallow the throw.
    await refreshJwks().catch(() => {});
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  return { mint, stop };
}
