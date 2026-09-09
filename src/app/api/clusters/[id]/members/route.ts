import { NextResponse } from "next/server"

import { authenticateRequest, authErrorResponse, requireRole } from "@/lib/auth/guard"
import { Role } from "@/generated/prisma/client"
import { clusterMemberInputSchema } from "@/lib/clusters/schema"
import { addClusterMember, removeClusterMember } from "@/lib/clusters/service"

type Params = { params: Promise<{ id: string }> }

// Joining a cluster backfills every project already in it and rewires the replication mesh,
// so this can take a while against a large or distant Harbor.
export async function POST(request: Request, { params }: Params) {
  try {
    requireRole(await authenticateRequest(request), Role.ADMIN)
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: "Unexpected error" }, { status: 500 })
  }

  const { id } = await params
  const parsed = clusterMemberInputSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }

  // `incoming` on a 409 is not a plain refusal: it is the list the client has to show before
  // re-sending with acceptExisting. `colliding` is a refusal that confirming cannot lift.
  const { error, colliding, incoming } = await addClusterMember(id, parsed.data.registryId, {
    acceptExisting: parsed.data.acceptExisting,
  })
  if (error) return NextResponse.json({ error, colliding, incoming }, { status: 409 })
  return NextResponse.json({ ok: true }, { status: 201 })
}

export async function DELETE(request: Request, { params }: Params) {
  try {
    requireRole(await authenticateRequest(request), Role.ADMIN)
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: "Unexpected error" }, { status: 500 })
  }

  const { id } = await params
  const registryId = new URL(request.url).searchParams.get("registryId")
  if (!registryId) return NextResponse.json({ error: "registryId is required" }, { status: 400 })

  const { error } = await removeClusterMember(id, registryId)
  if (error) return NextResponse.json({ error }, { status: 409 })
  return NextResponse.json({ ok: true })
}
