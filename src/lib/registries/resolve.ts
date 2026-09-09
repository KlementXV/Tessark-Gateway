import { decryptSecret } from "@/lib/crypto"
import type { Registry } from "@/generated/prisma/client"
import type { RegistryAuthType, RegistryConnection } from "./types"

export function resolveConnection(registry: Registry): RegistryConnection {
  return {
    id: registry.id,
    name: registry.name,
    baseUrl: registry.baseUrl,
    authType: registry.authType as RegistryAuthType,
    username: registry.username,
    secret: registry.encryptedSecret ? decryptSecret(registry.encryptedSecret) : null,
    insecureTLS: registry.insecureTLS,
  }
}

/**
 * Whether skopeo must be told to stop insisting on a verified HTTPS registry.
 *
 * Two distinct situations, one flag on the command line:
 *
 *   * `insecureTLS` — HTTPS with a certificate that will not verify (self-signed, private CA).
 *     This is what the checkbox on the registry form means.
 *   * a `http://` baseUrl — no TLS at all. Nothing in the UI marks this, because the scheme
 *     already says it; and skopeo will not fall back to HTTP on its own, it fails at the first
 *     blob with "server gave HTTP response to HTTPS client".
 *
 * Deriving the second from the URL rather than asking operators to also tick the box is the
 * point: a registry declared over plain HTTP that then refuses to be written to over plain
 * HTTP is a contradiction the Gateway should resolve by itself.
 */
export function skopeoNeedsInsecure(conn: Pick<RegistryConnection, "baseUrl" | "insecureTLS">): boolean {
  return conn.insecureTLS || conn.baseUrl.trim().toLowerCase().startsWith("http://")
}
