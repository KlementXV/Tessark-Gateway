import type { UpstreamSource } from "@/generated/prisma/client"

import { parseAllowedRepos } from "./repo"

export interface PublicSource {
  id: string
  name: string
  host: string
  authType: string
  username: string | null
  hasSecret: boolean
  allowedRepos: string[]
  enabled: boolean
  description: string | null
  createdAt: string
  updatedAt: string
}

// Never send `encryptedSecret` to the client — same rule as toPublicRegistry. `allowedRepos`
// is widened from its stored text form into the array the UI edits.
export function toPublicSource(source: UpstreamSource): PublicSource {
  return {
    id: source.id,
    name: source.name,
    host: source.host,
    authType: source.authType,
    username: source.username,
    hasSecret: Boolean(source.encryptedSecret),
    allowedRepos: parseAllowedRepos(source.allowedRepos),
    enabled: source.enabled,
    description: source.description,
    createdAt: source.createdAt.toISOString(),
    updatedAt: source.updatedAt.toISOString(),
  }
}

// What a requester needs to fill the pull form: which hosts they may pull from and what the
// allowed paths look like. No credential state at all — that is an admin's concern, and this
// shape reaches every signed-in user.
export interface PickableSource {
  id: string
  name: string
  host: string
  allowedRepos: string[]
}

export function toPickableSource(source: UpstreamSource): PickableSource {
  return {
    id: source.id,
    name: source.name,
    host: source.host,
    allowedRepos: parseAllowedRepos(source.allowedRepos),
  }
}
