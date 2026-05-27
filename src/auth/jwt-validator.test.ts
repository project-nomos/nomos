import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { generateKeyPairSync, sign as cryptoSign, randomUUID } from "node:crypto";
import { JwtValidationError, refreshJwks, verifyJwt } from "./jwt-validator.ts";

interface JwkResponse {
  keys: Array<{
    kid: string;
    kty: string;
    alg: string;
    crv?: string;
    x?: string;
  }>;
}

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function makeJwt(opts: {
  privateKey: Parameters<typeof cryptoSign>[2];
  kid: string;
  payload: Record<string, unknown>;
}): string {
  const header = { alg: "EdDSA", kid: opts.kid, typ: "JWT" };
  const h = base64url(Buffer.from(JSON.stringify(header), "utf-8"));
  const p = base64url(Buffer.from(JSON.stringify(opts.payload), "utf-8"));
  const signingInput = Buffer.from(`${h}.${p}`, "utf-8");
  const signature = cryptoSign(null, signingInput, opts.privateKey);
  return `${h}.${p}.${base64url(signature)}`;
}

describe("verifyJwt", () => {
  const originalJwks = process.env.AUTH_JWKS_URL;
  const originalOrg = process.env.NOMOS_ORG_ID;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    process.env.AUTH_JWKS_URL = "https://auth.test/jwks.json";
    process.env.NOMOS_ORG_ID = "org123";
    await refreshJwks().catch(() => undefined);
  });

  afterEach(() => {
    if (originalJwks === undefined) delete process.env.AUTH_JWKS_URL;
    else process.env.AUTH_JWKS_URL = originalJwks;
    if (originalOrg === undefined) delete process.env.NOMOS_ORG_ID;
    else process.env.NOMOS_ORG_ID = originalOrg;
    fetchSpy?.mockRestore?.();
  });

  function mockJwks(jwk: JwkResponse["keys"][number]): void {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      return new Response(JSON.stringify({ keys: [jwk] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as ReturnType<typeof vi.spyOn>;
  }

  it("accepts a well-formed JWT with matching org_id", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const kid = randomUUID();
    const jwkExport = publicKey.export({ format: "jwk" }) as JwkResponse["keys"][number];
    mockJwks({ ...jwkExport, kid, alg: "EdDSA" });

    const token = makeJwt({
      privateKey,
      kid,
      payload: {
        sub: "user-abc",
        org_id: "org123",
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
    });

    const ctx = await verifyJwt(token);
    expect(ctx.userId).toBe("user-abc");
    expect(ctx.orgId).toBe("org123");
  });

  it("rejects when org_id claim doesn't match NOMOS_ORG_ID", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const kid = randomUUID();
    const jwkExport = publicKey.export({ format: "jwk" }) as JwkResponse["keys"][number];
    mockJwks({ ...jwkExport, kid, alg: "EdDSA" });

    const token = makeJwt({
      privateKey,
      kid,
      payload: {
        sub: "user-abc",
        org_id: "wrong-org",
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
    });
    await expect(verifyJwt(token)).rejects.toThrow(JwtValidationError);
  });

  it("rejects expired tokens", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const kid = randomUUID();
    const jwkExport = publicKey.export({ format: "jwk" }) as JwkResponse["keys"][number];
    mockJwks({ ...jwkExport, kid, alg: "EdDSA" });

    const token = makeJwt({
      privateKey,
      kid,
      payload: {
        sub: "user-abc",
        org_id: "org123",
        exp: Math.floor(Date.now() / 1000) - 60,
      },
    });
    await expect(verifyJwt(token)).rejects.toThrow(JwtValidationError);
  });

  it("rejects tokens signed by an unknown key", async () => {
    const { publicKey } = generateKeyPairSync("ed25519");
    const { privateKey: otherPriv } = generateKeyPairSync("ed25519");
    const kid = randomUUID();
    const jwkExport = publicKey.export({ format: "jwk" }) as JwkResponse["keys"][number];
    mockJwks({ ...jwkExport, kid, alg: "EdDSA" });

    const token = makeJwt({
      privateKey: otherPriv,
      kid,
      payload: {
        sub: "user-abc",
        org_id: "org123",
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
    });
    await expect(verifyJwt(token)).rejects.toThrow(JwtValidationError);
  });

  it("rejects malformed tokens", async () => {
    await expect(verifyJwt("not.a.jwt.atall")).rejects.toThrow(JwtValidationError);
    await expect(verifyJwt("only-one-part")).rejects.toThrow(JwtValidationError);
  });
});
