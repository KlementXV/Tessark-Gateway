import { NextResponse } from "next/server"

import { authenticateRequest, authErrorResponse, hasRole } from "@/lib/auth/guard"
import { Role } from "@/generated/prisma/client"
import type { Session } from "next-auth"
import {
  ClusterIdentityConflictError,
  MissingClusterIdentityError,
  resolveHarborUsername,
  setClusterIdentity,
} from "@/lib/clusters/identity"
import { saveMemberAcrossCluster } from "@/lib/clusters/project-members"
import type { HarborUnknownUserReason } from "@/lib/registries/harbor"
import { loadProjectForAccess, requireManager } from "@/lib/projects/access"
import { prisma } from "@/lib/prisma"
import { memberAddInputSchema } from "@/lib/projects/schema"
import { notify } from "@/lib/notifications/service"

type Params = { params: Promise<{ id: string }> }

// "Unknown account" used to cover three situations with three different fixes. Each Harbor
// now says which one it is (src/lib/clusters/directory.ts, recoverUnknownUser).
function unknownAccountMessage(harborUsername: string, reason: HarborUnknownUserReason | null): string {
  switch (reason) {
    case "absent-from-directory":
      return `The cluster's LDAP directory has no account "${harborUsername}" — check the identifier: it must match the attribute Harbor searches on (ldap_uid).`
    case "not-yet-signed-in":
      return `No Harbor in the cluster knows "${harborUsername}" yet: they sign in to Harbor through OIDC, and Harbor only creates the account at that first sign-in. Ask them to sign in to Harbor once, then grant access again.`
    case "no-local-account":
      return `No Harbor in the cluster has a local account "${harborUsername}" — create it on Harbor before granting access.`
    default:
      return `No Harbor in the cluster knows the account "${harborUsername}" — it has to exist there (or in the directory) before it can be granted access.`
  }
}

export async function POST(request: Request, { params }: Params) {
  const { id } = await params
  let session: Session | null
  let project
  try {
    session = await authenticateRequest(request)
    const access = await loadProjectForAccess(id, session)
    requireManager(access.isManager)
    project = access.project
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: "Unexpected error" }, { status: 500 })
  }

  const body = await request.json().catch(() => null)
  const parsed = memberAddInputSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }

  const user = await prisma.user.findUnique({ where: { id: parsed.data.userId } })
  if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 })

  // The mapping is written before the row, since the fan-out below resolves the Harbor name
  // out of it. Recording it here is what lets the picker ask for the account and the grant in
  // a single gesture instead of sending an admin to a separate screen first.
  if (parsed.data.harborUsername) {
    // A mapping is cluster-wide: it decides which real account receives *every* grant this
    // person gets on this cluster, so a project manager who is not a global admin may add
    // people who are already mapped but never map one themselves.
    if (!hasRole(session, Role.ADMIN)) {
      return NextResponse.json(
        { error: "Only an administrator can map a user to an account on this cluster." },
        { status: 403 }
      )
    }
    try {
      await setClusterIdentity(user.id, project.clusterId, parsed.data.harborUsername)
    } catch (err) {
      if (err instanceof ClusterIdentityConflictError) {
        return NextResponse.json({ error: err.message }, { status: 409 })
      }
      throw err
    }
  }

  // Resolved up front so the failure lands before anything is written: on a cluster with its
  // own directory, an unmapped account is a refusal, never a fall back to User.username.
  const harborUsername = await resolveHarborUsername(user.id, project.clusterId)
  if (harborUsername === null) {
    return NextResponse.json(
      {
        error: `This cluster keeps its own user directory, and no account there is mapped to "${user.username}" yet.`,
        code: "MISSING_CLUSTER_IDENTITY",
      },
      { status: 409 }
    )
  }

  let member
  let summary
  try {
    ;({ member, summary } = await saveMemberAcrossCluster(id, parsed.data.userId, parsed.data.role, harborUsername))
  } catch (err) {
    // Nothing was pushed anywhere, so this is the caller's mistake to fix, not a Harbor
    // failure to retry — 409 rather than 502.
    if (err instanceof MissingClusterIdentityError) {
      return NextResponse.json(
        { error: err.message, code: "MISSING_CLUSTER_IDENTITY" },
        { status: 409 }
      )
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to add member" },
      { status: 502 }
    )
  }

  if (summary.succeeded === 0) {
    const detail = summary.failures.map((f) => `${f.registry}: ${f.error}`).join("; ")
    return NextResponse.json(
      {
        error: summary.unknownUserEverywhere
          ? unknownAccountMessage(harborUsername, summary.unknownUserReason ?? null)
          : `No Harbor in the cluster accepted the membership — ${detail}`,
      },
      { status: 502 }
    )
  }

  await notify({
    kind: "MEMBER_ADDED",
    payload: { project: project.name, role: parsed.data.role },
    audience: { userIds: [parsed.data.userId] },
    href: `/projects/${id}`,
    actorUserId: session!.user.id,
  })

  return NextResponse.json(
    {
      ...member,
      placements: {
        succeeded: summary.succeeded,
        failed: summary.failed,
        failures: summary.failures,
      },
    },
    { status: 201 }
  )
}
