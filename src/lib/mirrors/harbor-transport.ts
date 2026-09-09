// The harbor transport: a pull-mode replication policy with a scheduled trigger, living on
// the destination Harbor. Harbor holds the clock, does the pulling, retries on its own and
// keeps the execution log — the Gateway writes two objects and then only reads.
//
// This is the mirror image of src/lib/clusters/replication.ts, which wires the *mesh*: there
// the policy pushes outward from each member, here it pulls inward on one. Both create a
// registry endpoint first, because a Harbor policy can only name a registry it already knows.
import { prisma } from "@/lib/prisma"
import { pickWriteMember, type ClusterMember } from "@/lib/clusters/members"
import {
  createHarborPullPolicy,
  createHarborRegistryEndpoint,
  deleteHarborRegistryEndpoint,
  deleteHarborReplicationPolicy,
  triggerHarborReplication,
  updateHarborPullPolicy,
} from "@/lib/registries/harbor"
import { resolveConnection } from "@/lib/registries/resolve"
import { sourceCredentials } from "@/lib/sources/service"
import type { ScheduledMirror, UpstreamSource } from "@/generated/prisma/client"
import { toHarborCron } from "./cron"

// Deterministic, so a re-apply adopts what an earlier attempt created instead of duplicating
// it — the same reasoning as the mesh's endpoint names. One endpoint per mirror even when two
// mirrors share a source: they are then independently deletable, which matters more here than
// saving a Harbor object, since deleting an endpoint another policy still references fails.
function endpointName(mirrorId: string): string {
  return `tessark-mirror-src-${mirrorId}`
}

function policyName(mirrorId: string): string {
  return `tessark-mirror-${mirrorId}`
}

export class MirrorTransportError extends Error {
  status: number
  constructor(message: string, status = 502) {
    super(message)
    this.status = status
  }
}

type MirrorWithSource = ScheduledMirror & { source: UpstreamSource | null }

// Harbor needs to be told which adapter to speak: "harbor" for a Harbor we know (the same
// treatment the mesh gets), "docker-registry" for anything answering the plain v2 API.
//
// Docker Hub deliberately uses the *v2 endpoint* through the docker-registry adapter rather
// than Harbor's own "docker-hub" adapter, which was verified against Harbor v2.15.0 on
// 2026-09-04: the docker-hub adapter resolves a name filter by listing the namespace, and
// listing "library" anonymously fails with `pagination offset too large for anonymous
// requests`. The same mirror through registry-1.docker.io with an exact repository filter
// pulled library/nginx:latest into the destination project on the first try.
async function endpointSpecFor(mirror: MirrorWithSource): Promise<{
  type: string
  url: string
  username: string | null
  secret: string | null
  insecure: boolean
}> {
  if (mirror.source) {
    const host = mirror.source.host.toLowerCase()
    const isDockerHub = host === "docker.io" || host === "index.docker.io" || host === "registry-1.docker.io"
    const credentials = sourceCredentials(mirror.source)
    return {
      type: "docker-registry",
      url: isDockerHub ? "https://registry-1.docker.io" : `https://${mirror.source.host}`,
      // Harbor's endpoint credential is always an access key/secret pair, so a token-auth
      // source has nothing to hand it. That is a real limit of this transport rather than
      // something to paper over with a fake username.
      username: credentials?.kind === "basic" ? credentials.username : null,
      secret: credentials?.kind === "basic" ? credentials.secret : null,
      insecure: false,
    }
  }

  const registry = await prisma.registry.findUnique({ where: { id: mirror.sourceRegistryId! } })
  if (!registry) throw new MirrorTransportError("The source registry no longer exists.", 404)
  const conn = resolveConnection(registry)
  return {
    type: "harbor",
    url: conn.baseUrl,
    username: conn.username,
    secret: conn.secret,
    insecure: conn.insecureTLS,
  }
}

/**
 * Which Harbor carries the policy, and under which project name.
 *
 * A managed project spans a cluster, and only one member needs the policy: whatever it pulls
 * in lands there and the mesh carries it to the peers — the same reasoning that lets a skopeo
 * transfer push to a single member. The member is picked for health, so a mirror can be
 * re-applied onto a different one later; that is why the choice is recorded on the row.
 */
async function resolvePolicyHost(mirror: ScheduledMirror): Promise<{
  member: ClusterMember
  projectName: string
}> {
  if (!mirror.projectId) {
    // validateMirror refuses a delivery destination on this transport, so this is a row that
    // was written before that rule existed, or one edited by hand.
    throw new MirrorTransportError(
      "This mirror has no Gateway project to write the policy on.",
      400,
    )
  }

  const project = await prisma.project.findUnique({
    where: { id: mirror.projectId },
    select: { id: true, name: true, clusterId: true },
  })
  if (!project) throw new MirrorTransportError("The destination project no longer exists.", 404)

  const member = await pickWriteMember(project.clusterId, project.id)
  if (!member) {
    throw new MirrorTransportError(
      `No healthy Harbor in ${project.name}'s cluster is currently reachable — try again once one is back.`,
    )
  }
  return { member, projectName: project.name }
}

/** The repository path as it exists on the source, which is what Harbor's name filter matches. */
export function sourceRepoPath(mirror: ScheduledMirror): string {
  return mirror.sourceProjectName ? `${mirror.sourceProjectName}/${mirror.sourceRepo}` : mirror.sourceRepo
}

/**
 * Installs (or re-installs) the mirror on its destination Harbor. Idempotent: an existing
 * policy is updated in place, which is what makes editing a schedule a one-line change rather
 * than a delete-and-recreate that would lose Harbor's execution history.
 */
export async function applyHarborMirror(mirror: MirrorWithSource): Promise<{
  harborRegistryId: string
  harborEndpointId: number
  harborPolicyId: number
}> {
  const { member, projectName } = await resolvePolicyHost(mirror)
  const spec = await endpointSpecFor(mirror)

  const harborEndpointId = await createHarborRegistryEndpoint(member.conn, {
    name: endpointName(mirror.id),
    url: spec.url,
    username: spec.username,
    secret: spec.secret,
    insecure: spec.insecure,
    type: spec.type,
    description: "Managed by Tessark Gateway — scheduled mirror source.",
  })

  const input = {
    name: policyName(mirror.id),
    srcEndpointId: harborEndpointId,
    repo: sourceRepoPath(mirror),
    tag: mirror.sourceTag,
    destProject: projectName,
    cron: toHarborCron(mirror.schedule),
    enabled: mirror.enabled,
  }

  // A policy created on a different member (the healthy one has changed since) is left alone
  // rather than adopted: its id means nothing on this Harbor, and updating id 7 here would
  // rewrite whatever policy 7 happens to be.
  const reusable = mirror.harborPolicyId !== null && mirror.harborRegistryId === member.registryId
  const harborPolicyId = reusable
    ? (await updateHarborPullPolicy(member.conn, mirror.harborPolicyId!, input), mirror.harborPolicyId!)
    : await createHarborPullPolicy(member.conn, input)

  // The policy host moved: the previous member was unhealthy when this ran, so a new policy
  // was just created elsewhere. Left alone, the old one keeps its own schedule and pulls the
  // same mirror a second time the moment that Harbor recovers — and the row is about to stop
  // naming it, so deleteMirror() would never reach it either. Uninstalled after the new one
  // is in place, so a failure here costs an orphan (which the scanner reports) rather than a
  // mirror that is installed nowhere.
  if (!reusable && mirror.harborRegistryId && mirror.harborRegistryId !== member.registryId) {
    await removeHarborMirror(mirror)
  }

  return { harborRegistryId: member.registryId, harborEndpointId, harborPolicyId }
}

/**
 * Removes both Harbor objects. Best-effort by design: the row has to go regardless, and a
 * leftover disabled policy on a Harbor that is currently down is a smaller problem than a
 * mirror the Gateway can no longer see — the same trade removeReplicationLink makes.
 */
export async function removeHarborMirror(mirror: ScheduledMirror): Promise<void> {
  if (!mirror.harborRegistryId) return

  const registry = await prisma.registry.findUnique({ where: { id: mirror.harborRegistryId } })
  if (!registry) return
  const conn = resolveConnection(registry)

  try {
    if (mirror.harborPolicyId) await deleteHarborReplicationPolicy(conn, mirror.harborPolicyId)
    if (mirror.harborEndpointId) await deleteHarborRegistryEndpoint(conn, mirror.harborEndpointId)
  } catch {
    // Intentionally ignored — see the comment above.
  }
}

/** Runs the policy now, without waiting for the next cron tick. */
export async function runHarborMirrorNow(mirror: ScheduledMirror): Promise<void> {
  if (!mirror.harborRegistryId || !mirror.harborPolicyId) {
    throw new MirrorTransportError("This mirror is not installed on a Harbor yet.", 409)
  }
  const registry = await prisma.registry.findUnique({ where: { id: mirror.harborRegistryId } })
  if (!registry) throw new MirrorTransportError("The Harbor holding this policy no longer exists.", 404)

  await triggerHarborReplication(resolveConnection(registry), mirror.harborPolicyId)
}
