import type { UpstreamSource } from "@/generated/prisma/client"
import { decryptSecret } from "@/lib/crypto"
import { prisma } from "@/lib/prisma"

import { toPickableSource, toPublicSource, type PickableSource, type PublicSource } from "./public"

export async function listSources(): Promise<PublicSource[]> {
  const sources = await prisma.upstreamSource.findMany({ orderBy: { name: "asc" } })
  return sources.map(toPublicSource)
}

// Only enabled sources can be named in a new request — a disabled one stays resolvable for
// the history that already points at it, but is not offered.
export async function listPickableSources(): Promise<PickableSource[]> {
  const sources = await prisma.upstreamSource.findMany({
    where: { enabled: true },
    orderBy: { name: "asc" },
  })
  return sources.map(toPickableSource)
}

// Credentials for the pull side of a skopeo copy, decrypted. Server-only: the return value
// carries a plaintext secret and must never cross to the client.
export interface SourceCredentials {
  kind: "basic" | "token"
  username: string
  secret: string
}

export function sourceCredentials(source: UpstreamSource): SourceCredentials | null {
  if (source.authType === "none" || !source.encryptedSecret) return null
  return {
    kind: source.authType === "token" ? "token" : "basic",
    username: source.username ?? "",
    secret: decryptSecret(source.encryptedSecret),
  }
}
