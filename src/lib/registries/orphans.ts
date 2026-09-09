import { withReplicationLock } from "@/lib/clusters/replication-lock"
import { RegistryRole, type Registry } from "@/generated/prisma/client"
import { errorMessage } from "@/lib/clusters/fanout"
import { logger } from "@/lib/logger"
import { prisma } from "@/lib/prisma"
import { deleteHarborRegistryEndpoint, deleteHarborReplicationPolicy } from "@/lib/registries/harbor"
import { registryFetch } from "@/lib/registries/http"
import { resolveConnection } from "@/lib/registries/resolve"
import type { RegistryConnection } from "@/lib/registries/types"

/**
 * Objects the Gateway put on a Harbor and no longer accounts for.
 *
 * Everything the Gateway writes to a Harbor's replication machinery is named deterministically
 * — `tessark-peer-<registryId>`, `tessark-replicate-<registryId>`, `tessark-mirror-src-<mirrorId>`,
 * `tessark-mirror-<mirrorId>` — so that a replay adopts what an earlier attempt created. The
 * same property makes the reverse question answerable: a `tessark-*` object whose id no longer
 * resolves here is something we created and then lost track of.
 *
 * They matter because they are not inert. An orphaned replication policy is still enabled and
 * still fires, moving images on a schedule nothing in the Gateway can show, pause or explain.
 * They accumulate from every path that drops a row without unwinding the Harbor side: a
 * database reset or restored while the Harbors kept running, a member deleted while it was
 * unreachable, a cascade that skipped its cleanup (see ScheduledMirror's Restrict FKs, which
 * closed that particular door).
 *
 * Detection is read-only. Nothing is removed unless asked, by name.
 */

export type OrphanKind = "meshPolicy" | "meshEndpoint" | "mirrorPolicy" | "mirrorEndpoint"

export interface HarborOrphan {
  kind: OrphanKind
  /** Harbor's own numeric id for the object, which is what deletes it. */
  harborId: number
  name: string
  /** The Gateway id encoded in the name — a registry id, or a mirror id. */
  referencedId: string
  /** Whether a replication policy is currently armed. Endpoints carry no such state. */
  enabled: boolean | null
}

export interface RegistryOrphans {
  registryId: string
  registryName: string
  orphans: HarborOrphan[]
  /** Why this Harbor could not be inspected — never to be read as "it holds none". */
  error: string | null
}

const MESH_ENDPOINT = "tessark-peer-"
const MESH_POLICY = "tessark-replicate-"
const MIRROR_ENDPOINT = "tessark-mirror-src-"
const MIRROR_POLICY = "tessark-mirror-"

interface HarborNamed {
  id: number
  name: string
  enabled?: boolean
}

async function listNamed(conn: RegistryConnection, path: string): Promise<HarborNamed[]> {
  const res = await registryFetch(conn, `${path}?page_size=100`)
  if (!res.ok) throw new Error(`Harbor answered ${res.status} for ${path}`)
  return (await res.json()) as HarborNamed[]
}

/**
 * What the Gateway currently accounts for on one Harbor.
 *
 * A mesh object is legitimate only while a ReplicationLink actually runs *from this Harbor*
 * towards the peer named in it. The peer merely existing is not enough: a link torn down
 * leaves the row gone and the policy behind, which is precisely the case being hunted.
 */
async function expectedOn(registryId: string) {
  const [links, mirrors] = await Promise.all([
    prisma.replicationLink.findMany({
      where: { sourceRegistryId: registryId },
      select: { destRegistryId: true },
    }),
    prisma.scheduledMirror.findMany({
      where: { harborRegistryId: registryId },
      select: { id: true },
    }),
  ])
  return {
    meshPeers: new Set(links.map((link) => link.destRegistryId)),
    mirrorIds: new Set(mirrors.map((mirror) => mirror.id)),
  }
}

type Expected = Awaited<ReturnType<typeof expectedOn>>

/**
 * One Harbor object against what we expect. Policies and endpoints live in separate Harbor
 * collections, so the two mirror prefixes — `tessark-mirror-` and `tessark-mirror-src-`, one a
 * prefix of the other — are never tested against the same list and cannot be confused.
 */
function classify(
  object: HarborNamed,
  meshPrefix: string,
  meshKind: OrphanKind,
  mirrorPrefix: string,
  mirrorKind: OrphanKind,
  expected: Expected,
): HarborOrphan | null {
  const enabled = typeof object.enabled === "boolean" ? object.enabled : null

  const [prefix, kind, known] = object.name.startsWith(meshPrefix)
    ? ([meshPrefix, meshKind, expected.meshPeers] as const)
    : object.name.startsWith(mirrorPrefix)
      ? ([mirrorPrefix, mirrorKind, expected.mirrorIds] as const)
      : ([null, null, null] as const)

  // Not ours: a Harbor may hold replication policies its own team wrote, and they are none of
  // this scan's business.
  if (!prefix) return null

  const referencedId = object.name.slice(prefix.length)
  if (known.has(referencedId)) return null
  return { kind, harborId: object.id, name: object.name, referencedId, enabled }
}

async function inspectRegistry(registry: Registry): Promise<RegistryOrphans> {
  const header = { registryId: registry.id, registryName: registry.name }
  const conn = resolveConnection(registry)

  try {
    const [expected, policies, endpoints] = await Promise.all([
      expectedOn(registry.id),
      listNamed(conn, "/api/v2.0/replication/policies"),
      listNamed(conn, "/api/v2.0/registries"),
    ])

    const orphans = [
      ...policies
        .map((p) => classify(p, MESH_POLICY, "meshPolicy", MIRROR_POLICY, "mirrorPolicy", expected))
        .filter((o): o is HarborOrphan => o !== null),
      ...endpoints
        .map((e) =>
          classify(e, MESH_ENDPOINT, "meshEndpoint", MIRROR_ENDPOINT, "mirrorEndpoint", expected),
        )
        .filter((o): o is HarborOrphan => o !== null),
    ]

    return { ...header, orphans, error: null }
  } catch (err) {
    // A Harbor that would not answer is reported as unreadable, never as clean: "we found
    // none" and "we could not look" must not render the same.
    return { ...header, orphans: [], error: errorMessage(err) }
  }
}

/**
 * Scans every Harbor the Gateway administers, or one cluster's.
 *
 * DELIVERY registries are skipped: the Gateway never writes replication objects there, so a
 * `tessark-*` object found on one belongs to somebody else's Gateway, and removing it would be
 * well outside our remit.
 */
export async function findHarborOrphans(clusterId?: string): Promise<RegistryOrphans[]> {
  const registries = await prisma.registry.findMany({
    where: { role: RegistryRole.MANAGED, ...(clusterId ? { clusterId } : {}) },
    orderBy: { name: "asc" },
  })
  return Promise.all(registries.map(inspectRegistry))
}

export interface CleanupResult {
  deleted: number
  failures: Array<{ name: string; error: string }>
}

/**
 * Removes the named orphans from one Harbor.
 *
 * Policies before endpoints, always: Harbor refuses to delete an endpoint a policy still
 * references, so the reverse order fails on exactly the pairs that matter. The caller passes
 * the objects a scan returned rather than a "delete everything unaccounted for" flag — a
 * destructive sweep driven by a list the operator never saw is not something to offer.
 */
async function runDeleteHarborOrphans(
  registryId: string,
  orphans: HarborOrphan[],
): Promise<CleanupResult> {
  const registry = await prisma.registry.findUnique({ where: { id: registryId } })
  if (!registry) throw new Error("Registry not found")
  if (registry.role !== RegistryRole.MANAGED) {
    throw new Error("This Harbor is a delivery registry — the Gateway never wrote policies there.")
  }

  // The list arrives from the client, so it is confirmation of a scan — not authority to
  // delete. Re-scanning here and keeping only the intersection is what makes that true: a
  // Harbor id is just a number, and without this the route would delete any policy or
  // endpoint on this Harbor that a caller cared to name, in-use mesh links included. An
  // object that stopped being an orphan between the scan and the confirmation is now left
  // alone, which is the safe direction to err in.
  const current = await inspectRegistry(registry)
  if (current.error) {
    // "We could not look" must not read as "none of these are orphans any more" — the caller
    // turns a throw into a 502 carrying the Harbor's own reason.
    throw new Error(current.error)
  }
  const isOrphan = new Set(current.orphans.map((orphan) => `${orphan.kind}:${orphan.harborId}`))
  const confirmed = orphans.filter((orphan) => isOrphan.has(`${orphan.kind}:${orphan.harborId}`))

  const conn = resolveConnection(registry)
  const isPolicy = (orphan: HarborOrphan) =>
    orphan.kind === "meshPolicy" || orphan.kind === "mirrorPolicy"
  const ordered = [...confirmed.filter(isPolicy), ...confirmed.filter((o) => !isPolicy(o))]

  const failures: CleanupResult["failures"] = orphans
    .filter((orphan) => !isOrphan.has(`${orphan.kind}:${orphan.harborId}`))
    .map((orphan) => ({
      name: orphan.name,
      error: "No longer reported as an orphan on this Harbor — rescan and try again.",
    }))

  let deleted = 0
  for (const orphan of ordered) {
    try {
      if (isPolicy(orphan)) {
        await deleteHarborReplicationPolicy(conn, orphan.harborId)
      } else {
        await deleteHarborRegistryEndpoint(conn, orphan.harborId)
      }
      deleted += 1
      logger.info("Removed orphaned Harbor object", {
        registryId,
        kind: orphan.kind,
        name: orphan.name,
      })
    } catch (err) {
      failures.push({ name: orphan.name, error: errorMessage(err) })
    }
  }

  return { deleted, failures }
}

export async function deleteHarborOrphans(...args: Parameters<typeof runDeleteHarborOrphans>) {
  return withReplicationLock(() => runDeleteHarborOrphans(...args))
}
