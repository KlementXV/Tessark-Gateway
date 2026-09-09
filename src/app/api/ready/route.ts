import { NextResponse } from "next/server"

import { assertRuntimeConfig } from "@/lib/config"
import { k8sHealth } from "@/lib/k8s/client"
import { prisma } from "@/lib/prisma"

// Readiness: can this pod actually serve traffic. Kubernetes status is reported but never
// fails the probe — a pull-mirroring outage (Kubernetes API unreachable, or deliberately
// disabled via K8S_ENABLED=false) is not a reason to pull an otherwise-healthy web pod out of
// the Service. Only a broken config or an unreachable database do that.
//
// No error detail beyond a check name and status ever leaves this route — no DATABASE_URL, no
// database version, no stack trace (CLAUDE.md §4.7).
export async function GET() {
  const checks: Record<string, string> = {}
  let ready = true

  try {
    assertRuntimeConfig()
    checks.config = "ok"
  } catch {
    checks.config = "error"
    ready = false
  }

  try {
    await prisma.$queryRaw`SELECT 1`
    checks.database = "ok"
  } catch {
    checks.database = "error"
    ready = false
  }

  checks.kubernetes = (await k8sHealth()).status

  return NextResponse.json({ status: ready ? "ok" : "unavailable", checks }, { status: ready ? 200 : 503 })
}
