import { RegistryRole } from "@/generated/prisma/client"
import { reconcileRegistriesInBackground } from "@/lib/clusters/reconcile"
import { prisma } from "@/lib/prisma"
import { checkRegistryHealth, type RegistryHealth } from "./check"
import { isUsable } from "./health"
import { toPublicRegistry } from "./public"
import { resolveConnection } from "./resolve"
import { recordHarborObservationInBackground } from "./version-cache"
import type { RegistryAuthType, RegistryConnection } from "./types"

export async function listRegistriesWithHealth() {
  const registries = await prisma.registry.findMany({
    include: { cluster: { select: { id: true, name: true } } },
    orderBy: { name: "asc" },
  })

  const results = await Promise.all(
    registries.map(async (registry) => {
      const { cluster, ...row } = registry
      const health: RegistryHealth = await checkRegistryHealth(resolveConnection(row))
      recordHarborObservationInBackground(row, health)
      return { ...toPublicRegistry(row), cluster, health }
    })
  )

  // The app has no scheduler, so recovery is driven by whoever looks: any member that is
  // healthy again gets its queued fan-out replayed here, in the background. Failures stay in
  // the queue for the next pass, and POST /api/clusters/[id]/reconcile forces it on demand.
  reconcileRegistriesInBackground(
    results
      .filter((r) => isUsable(r.health) && r.clusterId && r.role === RegistryRole.MANAGED)
      .map((r) => r.id)
  )

  return results
}

export interface ConnectionInput {
  name?: string
  baseUrl: string
  authType: RegistryAuthType
  username?: string | null
  insecureTLS: boolean
}

// A probe-able connection for form input that has no database row yet.
export function connectionFromInput(input: ConnectionInput, secret: string | null): RegistryConnection {
  return {
    id: "",
    name: input.name ?? "",
    baseUrl: input.baseUrl,
    authType: input.authType,
    username: input.username ?? null,
    secret,
    insecureTLS: input.insecureTLS,
  }
}

// Gate for writes: a registry is only worth storing if it is a live Harbor that accepts
// the given credentials, since every project/robot/retention operation depends on all
// three. Returns the failure message, or null when the connection is good.
export async function rejectionReason(conn: RegistryConnection): Promise<string | null> {
  const health = await checkRegistryHealth(conn)
  if (isUsable(health)) return null
  return health.error ?? "Could not verify this Harbor registry."
}
