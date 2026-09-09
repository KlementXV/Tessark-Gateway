import { withReplicationLock } from "./replication-lock"
// The Gateway's own push account on a Harbor.
//
// A project robot (src/lib/clusters/robots.ts) is scoped to its project and has to be created
// by hand before anything can be mirrored there. That made every new project a two-step
// affair, and a transfer into a project without one failed with nothing to do about it at launch
// time. This module provisions the fallback: one Harbor *system-level* robot per registry,
// named after `SYSTEM_ROBOT_NAME`, holding push/pull on every project ("namespace": "*").
//
// Why not simply hand the skopeo Job the Harbor admin credentials already stored on the
// Registry row: those credentials configure Harbor — projects, robots, retention, replication
// — and they would end up in a Kubernetes Secret mounted into a pod that only ever needs to
// push one image. The system robot is push/pull only, revocable from Harbor's UI, and its
// loss costs a re-provision rather than the instance.
import { getConfig } from "@/lib/config"
import { decryptSecret, encryptSecret } from "@/lib/crypto"
import { logger } from "@/lib/logger"
import { prisma } from "@/lib/prisma"
import { createHarborSystemRobot, findHarborSystemRobot, setHarborRobotSecret } from "@/lib/registries/harbor"
import { RegistryRole } from "@/generated/prisma/client"
import { enqueue } from "./fanout"
import { generateRobotSecret } from "./robots"
import { assertManaged, toMember, type ClusterMember } from "./members"

export interface PushCredentials {
  username: string
  secret: string
}

export class SystemRobotError extends Error {}

// Provisioning is not atomic — find/create, then PATCH the secret, then store it — so two
// transfers starting at once on the same Harbor could each set a different secret and leave the
// stored one stale. One in-flight provision per registry is enough to prevent that within a
// pod; across replicas the loser's secret is simply re-provisioned on its next failure, which
// is why nothing downstream may assume the stored secret is eternally valid.
const inFlight = new Map<string, Promise<PushCredentials>>()

/**
 * The credentials of this Harbor's Gateway robot, provisioning it on first use.
 *
 * Returns null when the fallback is disabled by configuration — the caller then reports the
 * missing project robot as before. Throws SystemRobotError when the robot was wanted but
 * could not be established, which is a real failure of this Harbor and not a "no robot" case.
 */
export async function ensureSystemRobot(member: ClusterMember): Promise<PushCredentials | null> {
  // Provisioning a system-level robot is an administrative write, and a Harbor-wide one at
  // that. It is only ever legitimate on a registry the Gateway owns; on a DELIVERY registry
  // the push credential is the one stored on the row (see resolvePushCredentials).
  assertManaged(member)
  if (!getConfig().systemRobotEnabled) return null

  const stored = await loadStored(member.registryId)
  if (stored) return stored

  const pending = inFlight.get(member.registryId)
  if (pending) return pending

  const run = withReplicationLock(async () => (await loadStored(member.registryId)) ?? provision(member)).finally(() => inFlight.delete(member.registryId))
  inFlight.set(member.registryId, run)
  return run
}

async function loadStored(registryId: string): Promise<PushCredentials | null> {
  const registry = await prisma.registry.findUnique({
    where: { id: registryId },
    select: { systemRobotName: true, systemRobotSecret: true },
  })
  if (!registry?.systemRobotName || !registry.systemRobotSecret) return null
  return { username: registry.systemRobotName, secret: decryptSecret(registry.systemRobotSecret) }
}

async function provision(member: ClusterMember): Promise<PushCredentials> {
  const shortName = getConfig().systemRobotName
  const conn = member.conn
  const secret = generateRobotSecret()

  let harborId: number
  let fullName: string
  let issuedSecret: string | null = null

  // Adopting an existing robot rather than failing on the name collision is what makes this
  // survive a Gateway reinstall against a Harbor that already carries the robot: the row is
  // gone, the robot is not, and Harbor refuses a duplicate name.
  const existing = await findHarborSystemRobot(conn, shortName)
  if (existing) {
    harborId = existing.id
    fullName = existing.name
  } else {
    const created = await createHarborSystemRobot(conn, shortName)
    harborId = created.id
    fullName = created.name
    issuedSecret = created.secret
  }

  // Harbor mints its own secret and never shows it again, so a robot we adopted is unusable
  // until its secret is replaced by one we know.
  const aligned = await setHarborRobotSecret(conn, harborId, secret)
  const usable = aligned ? secret : issuedSecret
  if (!usable) {
    throw new SystemRobotError(
      `${member.registryName} refused to set the secret of its existing "${fullName}" robot — delete that robot in Harbor, or create a robot account on the project.`,
    )
  }

  // Read before the write: whether this Harbor already had a secret decides whether anyone
  // else is holding a stale copy of it (see the re-weave below).
  const before = await prisma.registry.findUnique({
    where: { id: member.registryId },
    select: { clusterId: true, systemRobotSecret: true },
  })

  await prisma.registry.update({
    where: { id: member.registryId },
    data: {
      systemRobotName: fullName,
      systemRobotId: harborId,
      systemRobotSecret: encryptSecret(usable),
      systemRobotSyncedAt: new Date(),
    },
  })

  logger.info("System robot provisioned", {
    registryId: member.registryId,
    registryName: member.registryName,
    robotName: fullName,
    adopted: Boolean(existing),
  })

  // This robot is also the login the *peers* of a cluster use to push into this Harbor
  // (clusters/replication.ts). Replacing a secret therefore invalidates an endpoint on each of
  // them, and none of them has any way to notice. Only on a *re*-provision: a first one has
  // nothing stale behind it, and the sync that needs the credential reads it directly.
  //
  // Queued rather than run here, so provisioning stays off the network path of whatever
  // transfer triggered it; the reconciler drains this on the next health read.
  if (member.role === RegistryRole.MANAGED && before?.clusterId && before.systemRobotSecret) {
    await enqueue({ registryId: member.registryId, kind: "REPLICATION_SYNC" })
  }

  return { username: fullName, secret: usable }
}

/**
 * Forgets the stored robot so the next transfer provisions a fresh one.
 *
 * The robot itself is left on Harbor: an operator rotating a credential they believe leaked
 * wants it deleted there, deliberately, rather than silently re-adopted by name on the next
 * transfer — which is exactly what deleting the row alone would do.
 */
export async function forgetSystemRobot(registryId: string): Promise<void> {
  await prisma.registry.update({
    where: { id: registryId },
    data: { systemRobotName: null, systemRobotId: null, systemRobotSecret: null, systemRobotSyncedAt: null },
  })
}

/** Provisions (or re-provisions) the robot outside a transfer — used by the registry UI. */
async function runSyncSystemRobot(registryId: string): Promise<PushCredentials | null> {
  const registry = await prisma.registry.findUnique({ where: { id: registryId } })
  if (!registry) return null
  const member = toMember(registry)
  assertManaged(member)
  return provision(member)
}

export async function syncSystemRobot(registryId: string): Promise<PushCredentials | null> {
  return withReplicationLock(() => runSyncSystemRobot(registryId))
}
