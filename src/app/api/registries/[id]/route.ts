import { withReplicationLock } from "@/lib/clusters/replication-lock"
import { NextResponse } from "next/server"

import { authenticateRequest, authErrorResponse, requireRole } from "@/lib/auth/guard"
import { syncClusterReplication, unlinkRegistry } from "@/lib/clusters/replication"
import { encryptSecret } from "@/lib/crypto"
import { RegistryRole, Role } from "@/generated/prisma/client"
import { logger } from "@/lib/logger"
import { prisma } from "@/lib/prisma"
import { toPublicRegistry } from "@/lib/registries/public"
import { registryUpdateInputSchema } from "@/lib/registries/schema"
import { connectionFromInput, rejectionReason } from "@/lib/registries/service"
import { resolveConnection } from "@/lib/registries/resolve"
import type { RegistryAuthType } from "@/lib/registries/types"
import { mirrorBlockMessage, mirrorsBlockingDelete } from "@/lib/mirrors/references"

type Params = { params: Promise<{ id: string }> }

const CONNECTION_FIELDS = ["baseUrl", "authType", "username", "secret", "insecureTLS"] as const

export async function GET(request: Request, { params }: Params) {
  try {
    requireRole(await authenticateRequest(request), Role.ADMIN)
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: "Unexpected error" }, { status: 500 })
  }

  const { id } = await params
  const registry = await prisma.registry.findUnique({ where: { id } })
  if (!registry) return NextResponse.json({ error: "Not found" }, { status: 404 })
  return NextResponse.json(toPublicRegistry(registry))
}

async function runPATCH(request: Request, { params }: Params) {
  try {
    requireRole(await authenticateRequest(request), Role.ADMIN)
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: "Unexpected error" }, { status: 500 })
  }

  const { id } = await params
  const body = await request.json().catch(() => null)
  const parsed = registryUpdateInputSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }

  const { secret, ...data } = parsed.data

  // Re-probe only when the connection itself moved — a rename or a description edit must
  // still go through while the Harbor is down.
  if (CONNECTION_FIELDS.some((field) => field in parsed.data)) {
    const existing = await prisma.registry.findUnique({ where: { id } })
    if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 })

    const current = resolveConnection(existing)
    const reason = await rejectionReason(
      connectionFromInput(
        {
          baseUrl: data.baseUrl ?? current.baseUrl,
          authType: (data.authType as RegistryAuthType | undefined) ?? current.authType,
          username: data.username !== undefined ? data.username : current.username,
          insecureTLS: data.insecureTLS ?? current.insecureTLS,
        },
        secret || current.secret
      )
    )
    if (reason) return NextResponse.json({ error: reason }, { status: 422 })
  }

  // Narrowing a Harbor to DELIVERY while it is still a cluster member would leave the
  // Gateway owning projects, robots and replication policies on a registry it just promised
  // never to write to. Leaving the cluster first is the operator's decision to make, not
  // something to do on their behalf as a side effect of an edit.
  if (data.role === RegistryRole.DELIVERY) {
    const existing = await prisma.registry.findUnique({ where: { id }, select: { clusterId: true } })
    if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 })
    if (existing.clusterId) {
      return NextResponse.json(
        { error: "Remove this Harbor from its cluster before turning it into a delivery registry." },
        { status: 409 },
      )
    }
  }

  const registry = await prisma.registry.update({
    where: { id },
    data: {
      ...data,
      // Only touch the stored secret when a new one is explicitly provided —
      // an empty PATCH must not wipe existing credentials.
      ...(secret ? { encryptedSecret: encryptSecret(secret) } : {}),
    },
  })

  // The peers of a cluster member hold an endpoint describing it — its URL, its login. Editing
  // any of that here without rewiring them leaves N-1 Harbors authenticating with a credential
  // that no longer works, while every ReplicationLink still reads ACTIVE. Forced, because what
  // changed lives on the *other* Harbors and no fingerprint of this edge would notice.
  //
  // Absorbed rather than surfaced: an unreachable peer must not make a registry edit fail. The
  // edges concerned are left FAILED with their reason and a REPLICATION_SYNC is queued.
  if (registry.clusterId && CONNECTION_FIELDS.some((field) => field in parsed.data)) {
    try {
      await syncClusterReplication(registry.clusterId, { force: true })
    } catch (err) {
      logger.warn("Replication re-sync after a registry edit failed", {
        registryId: id,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return NextResponse.json(toPublicRegistry(registry))
}

async function runDELETE(request: Request, { params }: Params) {
  try {
    requireRole(await authenticateRequest(request), Role.ADMIN)
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: "Unexpected error" }, { status: 500 })
  }

  const { id } = await params

  // A mirror reading from or pushing to this Harbor owns a schedule that only
  // DELETE /api/mirrors/[id] uninstalls. Refused by name rather than by foreign key.
  const blocking = await mirrorsBlockingDelete({ registryId: id })
  if (blocking.length > 0) {
    return NextResponse.json({ error: mirrorBlockMessage("registry", blocking) }, { status: 409 })
  }

  // Tear the replication mesh down first: the peers hold policies pointing at this Harbor,
  // and those live on the *other* registries, so cascading deletes would never reach them.
  await unlinkRegistry(id)
  await prisma.registry.delete({ where: { id } })
  return NextResponse.json({ ok: true })
}

export async function PATCH(request: Request, params: Params) {
  try {
    requireRole(await authenticateRequest(request), Role.ADMIN)
    return await withReplicationLock(() => runPATCH(request, params))
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: err instanceof Error ? err.message : "Registry update failed" }, { status: 409 })
  }
}

export async function DELETE(request: Request, params: Params) {
  try {
    requireRole(await authenticateRequest(request), Role.ADMIN)
    return await withReplicationLock(() => runDELETE(request, params))
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: err instanceof Error ? err.message : "Registry update failed" }, { status: 409 })
  }
}
