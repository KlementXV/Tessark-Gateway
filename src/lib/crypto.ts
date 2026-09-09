import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from "node:crypto"
import { getConfig } from "@/lib/config"

// Registry credentials (passwords/tokens) are encrypted at rest with AES-256-GCM.
// GATEWAY_SECRET_KEY is stretched through scrypt so any non-empty string works as input,
// not just a raw 32-byte key — keeps local setup to "put a passphrase in .env".
function deriveKey(): Buffer {
  return scryptSync(getConfig().gatewaySecretKey, "tessark-gateway", 32)
}

export function encryptSecret(plaintext: string): string {
  const key = deriveKey()
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
  const authTag = cipher.getAuthTag()
  return Buffer.concat([iv, authTag, ciphertext]).toString("base64")
}

export function decryptSecret(encoded: string): string {
  const key = deriveKey()
  const raw = Buffer.from(encoded, "base64")
  const iv = raw.subarray(0, 12)
  const authTag = raw.subarray(12, 28)
  const ciphertext = raw.subarray(28)
  const decipher = createDecipheriv("aes-256-gcm", key, iv)
  decipher.setAuthTag(authTag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8")
}

// One-way password hashing (scrypt, per-user random salt) — distinct from encryptSecret
// above, which is reversible and used for registry/robot credentials we need to read back.
export function hashPassword(password: string): string {
  const salt = randomBytes(16)
  const derived = scryptSync(password, salt, 64)
  return `${salt.toString("base64")}:${derived.toString("base64")}`
}

export function verifyPassword(password: string, stored: string): boolean {
  const [saltB64, hashB64] = stored.split(":")
  if (!saltB64 || !hashB64) return false
  const salt = Buffer.from(saltB64, "base64")
  const expected = Buffer.from(hashB64, "base64")
  const actual = scryptSync(password, salt, expected.length)
  if (actual.length !== expected.length) return false
  return timingSafeEqual(actual, expected)
}
