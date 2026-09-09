import { NextResponse } from "next/server"

import { authenticateRequest, authErrorResponse, requireRole } from "@/lib/auth/guard"
import { Role } from "@/generated/prisma/client"
import { getConfig } from "@/lib/config"
import { GATEWAY_MANAGED_BY, getJobLogs, listJobsByLabel } from "@/lib/k8s/client"

type Params = { params: Promise<{ name: string }> }

// A Kubernetes object name (RFC 1123 label). Checked before the value reaches a request path,
// so a crafted name cannot escape the namespace it is scoped to.
const JOB_NAME = /^[a-z0-9]([a-z0-9-]{0,251}[a-z0-9])?$/

/**
 * The skopeo output of one Job — what "check its logs" has meant up to now without offering
 * any way to do it.
 *
 * ADMIN, and restricted to Jobs the Gateway itself created: the ServiceAccount can read every
 * pod's log in its namespace, and nothing else in that namespace belongs to this application.
 */
export async function GET(request: Request, { params }: Params) {
  try {
    requireRole(await authenticateRequest(request), Role.ADMIN)
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: "Unexpected error" }, { status: 500 })
  }

  if (!getConfig().k8sEnabled) {
    return NextResponse.json({ error: "Kubernetes is disabled on this instance" }, { status: 409 })
  }

  const { name } = await params
  if (!JOB_NAME.test(name)) {
    return NextResponse.json({ error: "Invalid job name" }, { status: 400 })
  }

  try {
    // Asked of the API server as one exact question rather than by paging through the
    // namespace: a listing capped at N answers "not yours" for a Job that is simply the
    // N+1st, which is a 404 on the logs of a transfer the admin is looking straight at.
    const owned = await listJobsByLabel(GATEWAY_MANAGED_BY, 1, `metadata.name=${name}`)
    if (!owned.some((job) => job.name === name)) {
      return NextResponse.json({ error: "Not found" }, { status: 404 })
    }
    return NextResponse.json(await getJobLogs(name))
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to read logs" },
      { status: 502 },
    )
  }
}
