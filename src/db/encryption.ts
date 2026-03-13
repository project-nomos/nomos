/**
 * AES-256-GCM encryption for integration secrets at rest.
 *
 * Key source: ENCRYPTION_KEY env var (64 hex chars = 32 bytes).
 * Format: "iv_hex.ciphertext_hex.tag_hex"
 *
 * If ENCRYPTION_KEY is not set, secrets are stored as plaintext
 * with a console.warn (dev convenience).
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96-bit IV for GCM

function getKey(): Buffer | null {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex) return null;
  if (hex.length !== 64) {
    throw new Error("ENCRYPTION_KEY must be 64 hex characters (32 bytes). Generate with: openssl rand -hex 32");
  }
  return Buffer.from(hex, "hex");
}

let warnedOnce = false;

export function isEncryptionConfigured(): boolean {
  return Boolean(process.env.ENCRYPTION_KEY);
}

/**
 * Encrypt a plaintext string.
 * Returns "iv_hex.ciphertext_hex.tag_hex" or plaintext if no key is configured.
 */
export function encrypt(plaintext: string): string {
  const key = getKey();
  if (!key) {
    if (!warnedOnce) {
      console.warn("[encryption] ENCRYPTION_KEY not set — secrets stored as plaintext");
      warnedOnce = true;
    }
    return plaintext;
  }

  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `${iv.toString("hex")}.${encrypted.toString("hex")}.${tag.toString("hex")}`;
}

/**
 * Decrypt an encrypted string.
 * Accepts "iv_hex.ciphertext_hex.tag_hex" or plaintext passthrough if no key is configured.
 */
export function decrypt(encrypted: string): string {
  const key = getKey();
  if (!key) {
    return encrypted;
  }

  const parts = encrypted.split(".");
  if (parts.length !== 3) {
    // Not in encrypted format — return as-is (legacy plaintext)
    return encrypted;
  }

  const [ivHex, ciphertextHex, tagHex] = parts;
  const iv = Buffer.from(ivHex, "hex");
  const ciphertext = Buffer.from(ciphertextHex, "hex");
  const tag = Buffer.from(tagHex, "hex");

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString("utf8");
}

const NOMOS_DIR = path.join(os.homedir(), ".nomos");
const KEY_FILE = path.join(NOMOS_DIR, "encryption.key");

/**
 * Ensure an encryption key is available.
 *
 * Priority:
 * 1. ENCRYPTION_KEY env var (already set)
 * 2. ~/.nomos/encryption.key file
 * 3. Generate a new random key, persist to ~/.nomos/encryption.key, set env var
 *
 * Call this early in startup before any encrypt/decrypt operations.
 */
export function ensureEncryptionKey(): void {
  if (process.env.ENCRYPTION_KEY) return;

  // Try reading from file
  if (fs.existsSync(KEY_FILE)) {
    const key = fs.readFileSync(KEY_FILE, "utf-8").trim();
    if (key.length === 64) {
      process.env.ENCRYPTION_KEY = key;
      return;
    }
  }

  // Generate new key
  const key = randomBytes(32).toString("hex");

  // Ensure ~/.nomos directory exists
  if (!fs.existsSync(NOMOS_DIR)) {
    fs.mkdirSync(NOMOS_DIR, { recursive: true, mode: 0o700 });
  }

  fs.writeFileSync(KEY_FILE, key + "\n", { mode: 0o600 });
  process.env.ENCRYPTION_KEY = key;
}
