import { NextResponse } from "next/server"

import { authenticateRequest, authErrorResponse, requireRole } from "@/lib/auth/guard"
import { Role } from "@/generated/prisma/client"
import {
  applyClusterDirectoryConfig,
  DirectoryConfigDisabledError,
  DirectoryConfigIncompleteError,
} from "@/lib/clusters/directory-config"
import { clusterDirectoryApplyInputSchema } from "@/lib/clusters/schema"

// Writes the stored LDAP settings onto the cluster's Harbors, one after the other, each one
// testing them first. An explicit gesture, never queued and never replayed — see
// src/lib/clusters/directory-config.ts for why this write, unlike the others, must not be.
type Params = { params: Promise<{ id: string }> }

export async function POST(request: Request, { params }: Params) {
  try {
    requireRole(await authenticateRequest(request), Role.SUPERADMIN)
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: "Unexpected error" }, { status: 500 })
  }

  const { id } = await params
  const parsed = clusterDirectoryApplyInputSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Send {\"confirm\": true}: writing a directory configuration can lock every user of a Harbor out." },
      { status: 400 }
    )
  }

  try {
    const results = await applyClusterDirectoryConfig(id, parsed.data)
    return NextResponse.json({ results })
  } catch (err) {
    if (err instanceof DirectoryConfigDisabledError || err instanceof DirectoryConfigIncompleteError) {
      return NextResponse.json({ error: err.message }, { status: 409 })
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to apply the directory configuration" },
      { status: 502 }
    )
  }
}
