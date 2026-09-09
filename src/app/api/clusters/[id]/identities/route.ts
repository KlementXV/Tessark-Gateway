import { NextResponse } from "next/server"

import { authenticateRequest, authErrorResponse, requireRole } from "@/lib/auth/guard"
import { Role } from "@/generated/prisma/client"
import {
  ClusterIdentityConflictError,
  getClusterIdentity,
  listClusterIdentities,
} from "@/lib/clusters/identity"
import { applyClusterIdentityChange } from "@/lib/clusters/identity-sync"
import { pickHealthyMember } from "@/lib/clusters/members"
import { searchHarborUsers } from "@/lib/registries/harbor"
import { clusterIdentityInputSchema } from "@/lib/clusters/schema"
import { prisma } from "@/lib/prisma"

// Who is who on this cluster's Harbors. ADMIN-only: a mapping decides which real account
// receives a project grant, so writing one is an authorization decision, not a preference.
type Params = { params: Promise<{ id: string }> }

// Above this many mappings, the per-row directory lookups cost more than the answer is worth
// — the listing then comes back unverified rather than hammering Harbor.
const VERIFY_MAX = 50

export async function GET(request: Request, { params }: Params) {
  try {
    requireRole(await authenticateRequest(request), Role.ADMIN)
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: "Unexpected error" }, { status: 500 })
  }

  const { id } = await params
  // `userId` narrows the listing to one person — what the member picker asks for before
  // deciding whether it has to offer an account at all.
  const userId = new URL(request.url).searchParams.get("userId")
  if (userId) {
    const identity = await getClusterIdentity(userId, id)
    return NextResponse.json({ identities: identity ? [identity] : [] })
  }
  const identities = await listClusterIdentities(id)

  // `verify=1` asks the cluster's Harbor whether each mapped account still exists. It costs a
  // search per row, so it is opt-in and capped: an account deleted from the directory leaves
  // grants nothing can name any more, which nothing else here would surface. A cluster that
  // cannot be reached simply answers without the flag rather than failing the listing.
  if (new URL(request.url).searchParams.get("verify") === "1" && identities.length <= VERIFY_MAX) {
    const member = await pickHealthyMember(id)
    if (member) {
      const verified = await Promise.all(
        identities.map(async (identity) => {
          try {
            const matches = await searchHarborUsers(member.conn, identity.harborUsername)
            return {
              ...identity,
              known: matches.some(
                (account) =>
                  account.username.toLowerCase() === identity.harborUsername.toLowerCase()
              ),
            }
          } catch {
            return { ...identity, known: null }
          }
        })
      )
      return NextResponse.json({ identities: verified })
    }
  }

  return NextResponse.json({ identities })
}

export async function PUT(request: Request, { params }: Params) {
  try {
    requireRole(await authenticateRequest(request), Role.ADMIN)
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: "Unexpected error" }, { status: 500 })
  }

  const { id } = await params
  const parsed = clusterIdentityInputSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }

  const [cluster, user] = await Promise.all([
    prisma.cluster.findUnique({ where: { id }, select: { id: true } }),
    prisma.user.findUnique({ where: { id: parsed.data.userId }, select: { id: true } }),
  ])
  if (!cluster) return NextResponse.json({ error: "Cluster not found" }, { status: 404 })
  if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 })

  try {
    // Writes the mapping *and* moves the grants that follow from it — see
    // applyClusterIdentityChange: the old account is revoked before the new one is granted.
    const result = await applyClusterIdentityChange(user.id, id, parsed.data.harborUsername)
    return NextResponse.json(result)
  } catch (err) {
    if (err instanceof ClusterIdentityConflictError) {
      return NextResponse.json({ error: err.message }, { status: 409 })
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to save the mapping" },
      { status: 502 }
    )
  }
}
