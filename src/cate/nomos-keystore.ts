/**
 * Nomos CATE keystore — implements @cate-protocol/sdk Keystore
 * using Nomos's existing encryption infrastructure.
 *
 * Keys are stored in the database (integrations table) with
 * secrets encrypted via AES-256-GCM from src/db/encryption.ts.
 * Uses Node.js crypto for Ed25519 operations (no extra deps).
 */

import { generateKeyPairSync, sign, verify, createPublicKey, createPrivateKey } from "node:crypto";
import type { Keystore, KeyPair } from "@cate-protocol/sdk/identity";
import { getDb } from "../db/client.ts";
import { encrypt, decrypt } from "../db/encryption.ts";

const INTEGRATION_PREFIX = "cate-key:";

export class NomosKeystore implements Keystore {
  async generateKey(keyId: string): Promise<KeyPair> {
    const { publicKey: pubDer, privateKey: privDer } = generateKeyPairSync("ed25519", {
      publicKeyEncoding: { type: "spki", format: "der" },
      privateKeyEncoding: { type: "pkcs8", format: "der" },
    });

    // Extract raw 32-byte keys from DER encoding
    const publicKey = new Uint8Array(pubDer.subarray(pubDer.length - 32));
    const privateKey = new Uint8Array(privDer.subarray(privDer.length - 32));

    // Store encrypted in integrations table
    const sql = getDb();
    const secretData = JSON.stringify({
      publicKey: Buffer.from(publicKey).toString("hex"),
      privateKey: Buffer.from(privateKey).toString("hex"),
    });

    const configJson = JSON.stringify({ type: "cate-keypair", algorithm: "Ed25519" });
    const metadataJson = JSON.stringify({ keyId, createdAt: new Date().toISOString() });

    await sql`
      INSERT INTO integrations (name, enabled, config, secrets, metadata)
      VALUES (
        ${INTEGRATION_PREFIX + keyId},
        true,
        ${sql.json(configJson)},
        ${encrypt(secretData)},
        ${sql.json(metadataJson)}
      )
      ON CONFLICT (name) DO UPDATE SET
        secrets = EXCLUDED.secrets,
        updated_at = now()
    `;

    return { publicKey, privateKey };
  }

  async getKey(keyId: string): Promise<KeyPair | null> {
    const sql = getDb();
    const [row] = await sql<{ secrets: string }[]>`
      SELECT secrets FROM integrations
      WHERE name = ${INTEGRATION_PREFIX + keyId}
    `;

    if (!row) return null;

    const data = JSON.parse(decrypt(row.secrets));
    return {
      publicKey: new Uint8Array(Buffer.from(data.publicKey, "hex")),
      privateKey: new Uint8Array(Buffer.from(data.privateKey, "hex")),
    };
  }

  async sign(keyId: string, data: Uint8Array): Promise<Uint8Array> {
    const key = await this.getKey(keyId);
    if (!key) throw new Error(`CATE key not found: ${keyId}`);

    // Build PKCS8 DER for Ed25519 private key (48 bytes: 16-byte header + 32-byte key)
    const pkcs8Header = Buffer.from("302e020100300506032b657004220420", "hex");
    const privKeyDer = Buffer.concat([pkcs8Header, Buffer.from(key.privateKey)]);
    const privKeyObj = createPrivateKey({ key: privKeyDer, format: "der", type: "pkcs8" });

    const sig = sign(null, Buffer.from(data), privKeyObj);
    return new Uint8Array(sig);
  }

  async verify(publicKey: Uint8Array, data: Uint8Array, signature: Uint8Array): Promise<boolean> {
    // Build SPKI DER for Ed25519 public key (44 bytes: 12-byte header + 32-byte key)
    const spkiHeader = Buffer.from("302a300506032b6570032100", "hex");
    const pubKeyDer = Buffer.concat([spkiHeader, Buffer.from(publicKey)]);
    const pubKeyObj = createPublicKey({ key: pubKeyDer, format: "der", type: "spki" });

    return verify(null, Buffer.from(data), pubKeyObj, Buffer.from(signature));
  }

  async listKeys(): Promise<string[]> {
    const sql = getDb();
    const rows = await sql<{ name: string }[]>`
      SELECT name FROM integrations
      WHERE name LIKE ${INTEGRATION_PREFIX + "%"}
    `;
    return rows.map((r) => r.name.slice(INTEGRATION_PREFIX.length));
  }

  async deleteKey(keyId: string): Promise<void> {
    const sql = getDb();
    await sql`
      DELETE FROM integrations
      WHERE name = ${INTEGRATION_PREFIX + keyId}
    `;
  }
}
