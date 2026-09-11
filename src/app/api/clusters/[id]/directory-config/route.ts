import { NextResponse } from "next/server"

import { authenticateRequest, authErrorResponse, requireRole } from "@/lib/auth/guard"
import { Role } from "@/generated/prisma/client"
import { deleteDirectoryConfig, getDirectoryConfig, saveDirectoryConfig } from "@/lib/clusters/directory-config"
import { clusterDirectoryConfigInputSchema } from "@/lib/clusters/schema"
import { prisma } from "@/lib/prisma"

// The LDAP settings the Gateway may write onto this cluster's Harbors — stored here, written by
// ./apply only. SUPERADMIN throughout: these settings decide who can sign in to every Harbor of the
// cluster, and they carry a directory service account's password (docs/plan-ldap-sso-local.md, lot 7).
type Params = { params: Promise<{ id: string }> }

async function guard(request: Request) {
  requireRole(await authenticateRequest(request), Role.SUPERADMIN)
}

async function clusterExists(id: string) {
  return Boolean(await prisma.cluster.findUnique({ where: { id }, select: { id: true } }))
}

export async function GET(request: Request, { params }: Params) {
  try {
    await guard(request)
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: "Unexpected error" }, { status: 500 })
  }
  const { id } = await params
  if (!(await clusterExists(id))) return NextResponse.json({ error: "Cluster not found" }, { status: 404 })
  return NextResponse.json(await getDirectoryConfig(id))
}

export async function PUT(request: Request, { params }: Params) {
  try {
    await guard(request)
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: "Unexpected error" }, { status: 500 })
  }
  const { id } = await params
  if (!(await clusterExists(id))) return NextResponse.json({ error: "Cluster not found" }, { status: 404 })

  const parsed = clusterDirectoryConfigInputSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }
  await saveDirectoryConfig(id, parsed.data)
  return NextResponse.json(await getDirectoryConfig(id))
}

export async function DELETE(request: Request, { params }: Params) {
  try {
    await guard(request)
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: "Unexpected error" }, { status: 500 })
  }
  const { id } = await params
  await deleteDirectoryConfig(id)
  return NextResponse.json({ ok: true })
}
