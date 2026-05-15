/**
 * AES-256-GCM encryption for integration secrets at rest.
 * Mirrors src/db/encryption.ts on the daemon side so both processes share
 * the same key (env -> .env -> ~/.nomos/encryption.key) and ciphertext format.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readEnv } from "@/lib/env";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;

let cachedKey: string | null | undefined;

export function getEncryptionKey(): string | undefined {
  if (cachedKey !== undefined) return cachedKey ?? undefined;

  let key: string | undefined;
  if (process.env.ENCRYPTION_KEY) {
    key = process.env.ENCRYPTION_KEY;
  } else {
    const env = readEnv();
    if (env.ENCRYPTION_KEY) {
      key = env.ENCRYPTION_KEY;
    } else {
      try {
        const keyFile = path.join(os.homedir(), ".nomos", "encryption.key");
        if (fs.existsSync(keyFile)) {
          const fileKey = fs.readFileSync(keyFile, "utf-8").trim();
          if (fileKey.length === 64) key = fileKey;
        }
      } catch {
        // ignore
      }
    }
  }

  if (key && key.length === 64) {
    process.env.ENCRYPTION_KEY = key;
    cachedKey = key;
    return key;
  }
  cachedKey = null;
  return undefined;
}

/** Encrypt a string. Returns "iv.cipher.tag" hex format, or the input if no key. */
export function encryptSecret(plaintext: string): string {
  const key = getEncryptionKey();
  if (!key) return plaintext;
  const keyBuf = Buffer.from(key, "hex");
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, keyBuf, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}.${enc.toString("hex")}.${tag.toString("hex")}`;
}

/** Decrypt "iv.cipher.tag". Passes through anything that isn't in that format. */
export function decryptSecret(value: string): string {
  if (!value) return value;
  const key = getEncryptionKey();
  if (!key) return value;
  const parts = value.split(".");
  if (parts.length !== 3) return value;
  try {
    const keyBuf = Buffer.from(key, "hex");
    const [ivHex, cipherHex, tagHex] = parts;
    const iv = Buffer.from(ivHex, "hex");
    const ct = Buffer.from(cipherHex, "hex");
    const tag = Buffer.from(tagHex, "hex");
    const decipher = createDecipheriv(ALGORITHM, keyBuf, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch {
    return value;
  }
}

export function isEncrypted(value: string): boolean {
  if (!value) return false;
  const parts = value.split(".");
  return parts.length === 3 && parts.every((p) => /^[0-9a-f]+$/i.test(p));
}
