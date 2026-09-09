import { NextResponse } from "next/server"

import { authenticateRequest, authErrorResponse, requireRole } from "@/lib/auth/guard"
import { Role } from "@/generated/prisma/client"
import { clusterInputSchema } from "@/lib/clusters/schema"
import {
  ClusterIdentityModeError,
  deleteCluster,
  loadClusterDetail,
  updateCluster,
} from "@/lib/clusters/service"

type Params = { params: Promise<{ id: string }> }

// ADMIN, for the same reason as the collection above — and one more: the detail embeds every
// project of the cluster, which would let any signed-in user enumerate projects that
// listProjectsForSession deliberately keeps out of their sight.
export async function GET(request: Request, { params }: Params) {
  try {
    requireRole(await authenticateRequest(request), Role.ADMIN)
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: "Unexpected error" }, { status: 500 })
  }

  const { id } = await params
  const cluster = await loadClusterDetail(id)
  if (!cluster) return NextResponse.json({ error: "Not found" }, { status: 404 })
  return NextResponse.json(cluster)
}

export async function PUT(request: Request, { params }: Params) {
  try {
    requireRole(await authenticateRequest(request), Role.ADMIN)
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: "Unexpected error" }, { status: 500 })
  }

  const { id } = await params
  const parsed = clusterInputSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }

  try {
    return NextResponse.json(await updateCluster(id, parsed.data))
  } catch (err) {
    if (err instanceof ClusterIdentityModeError) {
      return NextResponse.json({ error: err.message, users: err.users }, { status: 409 })
    }
    if (err instanceof Error && err.message.includes("Unique constraint")) {
      return NextResponse.json({ error: "A cluster with this name already exists." }, { status: 409 })
    }
    // The row is updated before the replication rewrite, so a peer being unreachable leaves
    // the new settings saved and the mesh queued for repair rather than failing the edit.
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to update the cluster" },
      { status: 502 }
    )
  }
}

export async function DELETE(request: Request, { params }: Params) {
  try {
    requireRole(await authenticateRequest(request), Role.ADMIN)
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: "Unexpected error" }, { status: 500 })
  }

  const { id } = await params
  const { error } = await deleteCluster(id)
  if (error) return NextResponse.json({ error }, { status: 409 })
  return NextResponse.json({ ok: true })
}
