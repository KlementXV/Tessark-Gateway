import { retryAt } from "./replication-retry"
import { getConfig } from "@/lib/config"
import { encryptSecret } from "@/lib/crypto"
import { withReplicationLock } from "./replication-lock"
import { drainReplicationCleanup } from "./replication-cleanup"
import { createHash } from "node:crypto"

import { logger } from "@/lib/logger"
import { prisma } from "@/lib/prisma"
import {
  createHarborRegistryEndpoint,
  createHarborReplicationPolicy,
  pingHarborRegistryEndpoint,
  updateHarborRegistryEndpoint,
  updateHarborReplicationPolicy,
  type ReplicationTrigger,
} from "@/lib/registries/harbor"
import { enqueue, fanOut, errorMessage } from "./fanout"
import { assertManaged, loadClusterMembers, loadMember, type ClusterMember } from "./members"
import { ensureSystemRobot } from "./system-robot"

// Full mesh: N×(N-1) directed push policies. Replication is asynchronous; a successful
// push to one member is not a quorum acknowledgement. Concurrent updates of the same tag
// have no conflict ordering, and a full catch-up cannot replay missed deletion events.
// See docs/replication/README.md for the operational contract.
//
// Three properties this file is responsible for, none of which the topology gives for free:
//
//   * What is on Harbor matches what the peer row says *now* — not what it said the day the
//     link was first written. Hence the fingerprint, and the endpoint update path.
//   * A link is only ACTIVE once the source Harbor has said it can reach the destination.
//     The Gateway reaching both proves nothing about one reaching the other.
//   * A failure is attributed to the edge that failed, never to the whole source.

// Deterministic so a replay finds what an earlier attempt created rather than duplicating
// it. Registry IDs are cuids, which are already safe for Harbor's name charset.
function endpointName(destRegistryId: string): string {
  return `tessark-peer-${destRegistryId}`
}

function policyName(destRegistryId: string): string {
  return `tessark-replicate-${destRegistryId}`
}

function triggerFor(mode: string, cron: string | null): ReplicationTrigger {
  return mode === "scheduled" ? { type: "scheduled", cron: cron || "0 0 * * * *" } : { type: "event_based" }
}

/** The login one Harbor uses to push into a peer. */
interface PeerCredentials {
  username: string | null
  secret: string | null
}

// Everything about one edge that, if it changed, means the objects on the source Harbor are
// now wrong. The peer's secret is part of that — a rotated password is the drift this whole
// mechanism exists to catch — so the tuple is hashed rather than stored: the digest is enough
// to compare, and a second copy of a credential is not something to leave lying in a table.
function fingerprint(
  dest: ClusterMember,
  credentials: PeerCredentials,
  trigger: ReplicationTrigger
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        dest.conn.baseUrl,
        credentials.username,
        credentials.secret,
        dest.conn.insecureTLS,
        trigger.type,
        trigger.type === "scheduled" ? trigger.cron : null,
      ])
    )
    .digest("hex")
}

/**
 * The credentials a peer's endpoint should carry.
 *
 * Preferring the Gateway's own robot over the admin account stored on the Registry row is the
 * same argument system-robot.ts already makes for skopeo Jobs, and it is stronger here: the
 * endpoint deposits this credential on N-1 *other* Harbors, where it stays. With the admin
 * account, compromising any one member hands over the whole cluster.
 *
 * The fallback is deliberately loud rather than silent: losing the robot degrades security,
 * and an operator who never sees it said would never know the mesh runs on admin credentials.
 */
async function peerCredentials(dest: ClusterMember): Promise<PeerCredentials> {
  try {
    const robot = await ensureSystemRobot(dest)
    if (robot) return { username: robot.username, secret: robot.secret }
    logger.warn("Replication peer falls back to admin credentials: system robot disabled", {
      registryId: dest.registryId,
    })
  } catch (err) {
    logger.warn("Replication peer falls back to admin credentials: system robot unavailable", {
      registryId: dest.registryId,
      error: errorMessage(err),
    })
  }
  return { username: dest.conn.username, secret: dest.conn.secret }
}

/** Raised when the source Harbor cannot reach the peer. Carries Harbor's own wording. */
export class ReplicationUnreachableError extends Error {
  constructor(sourceName: string, destName: string, reason: string) {
    super(`${sourceName} cannot reach ${destName}: ${reason}`)
    this.name = "ReplicationUnreachableError"
  }
}

interface ApplyOptions {
  /** Rewrite the Harbor objects even when the fingerprint says nothing moved. */
  force?: boolean
}

// Wires one direction of the mesh on the source Harbor. Idempotent in two senses: the
// endpoint and policy lookups adopt whatever a previous run left behind, and an edge whose
// fingerprint is unchanged costs no network at all.
export async function applyReplicationLink(
  source: ClusterMember,
  dest: ClusterMember,
  trigger: ReplicationTrigger,
  options: ApplyOptions = {}
): Promise<void> {
  // Both ends are administrative writes on Harbors the Gateway owns. loadClusterMembers
  // already filters on MANAGED; this is the belt for the exported entry point.
  assertManaged(source)
  assertManaged(dest)

  const where = {
    sourceRegistryId_destRegistryId: {
      sourceRegistryId: source.registryId,
      destRegistryId: dest.registryId,
    },
  }
  const link = await prisma.replicationLink.findUnique({ where })

  if (!options.force && link?.status === "FAILED" && link.nextAttemptAt > new Date()) {
    throw new Error(link.lastError ?? "Replication retry is waiting for its backoff")
  }
  const cleanup = await prisma.replicationCleanup.findFirst({ where: {
    sourceRegistryId: source.registryId, destRegistryId: dest.registryId,
  } })
  if (cleanup) throw new Error("Previous replication objects are still being removed")

  const credentials = await peerCredentials(dest)
  const wanted = fingerprint(dest, credentials, trigger)

  // Nothing moved since the last successful apply: no endpoint write, no policy write, no
  // ping. This is what makes a cluster rename, or a reconcile pass triggered by a page load,
  // cost nothing. POST /api/clusters/[id]/replication passes force to bypass it.
  if (
    !options.force &&
    link &&
    link.status === "ACTIVE" &&
    link.appliedFingerprint === wanted &&
    link.harborEndpointId !== null &&
    link.harborPolicyId !== null &&
    link.lastPingAt &&
    Date.now() - link.lastPingAt.getTime() < getConfig().replicationVerifySeconds * 1000
  ) {
    return
  }

  const endpointInput = {
    name: endpointName(dest.registryId),
    url: dest.conn.baseUrl,
    username: credentials.username,
    secret: credentials.secret,
    insecure: dest.conn.insecureTLS,
  }

  // Update in place when we already know the endpoint: creating again would 409 and hand back
  // the id of an object still holding the *old* URL and password.
  let harborEndpointId = link?.harborEndpointId ?? null
  if (harborEndpointId !== null) {
    const updated = await updateHarborRegistryEndpoint(source.conn, harborEndpointId, endpointInput)
    // Gone from Harbor — someone deleted it by hand, or the Harbor was rebuilt.
    if (!updated) harborEndpointId = null
  }
  if (harborEndpointId === null) {
    harborEndpointId = await createHarborRegistryEndpoint(source.conn, endpointInput)
  }

  // Recorded before the probe so a link that fails the next step still says which endpoint it
  // owns — otherwise a ping failure would leave an untracked object on the source Harbor.
  await prisma.replicationLink.upsert({
    where,
    create: {
      sourceRegistryId: source.registryId,
      destRegistryId: dest.registryId,
      harborEndpointId,
      status: "PENDING",
      appliedBaseUrl: dest.conn.baseUrl,
    },
    update: { harborEndpointId, appliedBaseUrl: dest.conn.baseUrl, appliedFingerprint: null },
  })

  // Ask the source Harbor itself. An endpoint the Gateway can describe but the source cannot
  // reach yields a policy that logs a failed execution on every push — a worse diagnostic than
  // the edge simply refusing to come up with the reason attached.
  const unreachable = await pingHarborRegistryEndpoint(source.conn, harborEndpointId)
  if (unreachable) {
    throw new ReplicationUnreachableError(source.registryName, dest.registryName, unreachable)
  }

  let harborPolicyId = link?.harborPolicyId ?? null
  if (harborPolicyId) {
    const updated = await updateHarborReplicationPolicy(
      source.conn,
      harborPolicyId,
      policyName(dest.registryId),
      harborEndpointId,
      trigger
    )
    if (!updated) harborPolicyId = null
  }
  if (harborPolicyId === null) {
    harborPolicyId = await createHarborReplicationPolicy(
      source.conn,
      policyName(dest.registryId),
      harborEndpointId,
      trigger
    )
  }

  await prisma.replicationLink.update({
    where,
    data: {
      harborEndpointId,
      harborPolicyId,
      status: "ACTIVE",
      lastError: null,
      appliedFingerprint: wanted,
      appliedBaseUrl: dest.conn.baseUrl,
      lastPingAt: new Date(),
      ...(!link || link.status !== "ACTIVE" || link.harborPolicyId !== harborPolicyId
        ? { catchUpRequested: true, attempts: 0, nextAttemptAt: new Date() } : {}),
    },
  })
}

// Marks the one edge that failed, creating its row if the failure happened before it existed.
// Scoped to the edge on purpose: a source with three peers and one bad link used to report all
// three as broken, which pointed the operator at the wrong Harbor.
async function recordEdgeFailure(
  sourceRegistryId: string,
  destRegistryId: string,
  error: string
): Promise<void> {
  const previous = await prisma.replicationLink.findUnique({
    where: { sourceRegistryId_destRegistryId: { sourceRegistryId, destRegistryId } },
  })
  if (previous?.status === "FAILED" && previous.nextAttemptAt > new Date()) return
  await prisma.replicationLink.upsert({
    where: { sourceRegistryId_destRegistryId: { sourceRegistryId, destRegistryId } },
    create: { sourceRegistryId, destRegistryId, status: "FAILED", lastError: error, attempts: 1, nextAttemptAt: retryAt(0) },
    // The fingerprint is cleared so the next pass retries rather than short-circuiting on a
    // state that was never actually reached.
    update: { status: "FAILED", lastError: error, appliedFingerprint: null,
      attempts: { increment: 1 }, nextAttemptAt: retryAt(previous?.attempts ?? 0) },
  })
}

// Persist teardown before removing the edge, including enough encrypted connection data to
// finish after the Registry itself is deleted. A failed disable remains visible and retryable.
export async function removeReplicationLink(linkId: string): Promise<void> {
  return withReplicationLock(async () => {
    const link = await prisma.replicationLink.findUnique({ where: { id: linkId } })
    if (!link) return
    const source = await loadMember(link.sourceRegistryId)
    if (!source) throw new Error("Cannot retain replication cleanup without its source connection")
    await prisma.$transaction([
      prisma.replicationCleanup.upsert({ where: { id: link.id }, update: {}, create: {
        id: link.id, sourceRegistryId: link.sourceRegistryId, destRegistryId: link.destRegistryId,
        encryptedConnection: encryptSecret(JSON.stringify(source.conn)),
        harborPolicyId: link.harborPolicyId, harborEndpointId: link.harborEndpointId,
      } }),
      prisma.replicationLink.delete({ where: { id: link.id } }),
    ])
    await drainReplicationCleanup(link.id)
  })
}

export interface ReplicationSyncSummary {
  /** Directed edges a full mesh needs for this cluster right now. */
  desired: number
  /** Edges — not sources — that are wired and confirmed reachable. */
  succeeded: number
  /** Edges that could not be wired; each carries its reason on its own row. */
  failed: number
  removed: number
}

export interface SyncOptions {
  /**
   * Rewrite every edge even when nothing changed. Set by the operator-facing routes, whose
   * whole point is "check and repair", and by the queued REPLICATION_SYNC replay, which runs
   * precisely because something was previously wrong.
   */
  force?: boolean
}

// Shared across Gateway pods and reentrant during a membership change.
export async function syncClusterReplication(
  clusterId: string,
  options: SyncOptions = {}
): Promise<ReplicationSyncSummary> {
  return withReplicationLock(() => runClusterSync(clusterId, options.force ?? false))
}

// Brings the whole mesh in line with the cluster's current membership and mode: adds the
// links that should exist, drops the ones that shouldn't (a member left, or replication was
// turned off), and queues the sources it couldn't reach.
async function runClusterSync(clusterId: string, force: boolean): Promise<ReplicationSyncSummary> {
  const cluster = await prisma.cluster.findUnique({ where: { id: clusterId } })
  if (!cluster) throw new Error(`Cluster ${clusterId} not found`)

  const members = await loadClusterMembers(clusterId)
  const memberIds = new Set(members.map((m) => m.registryId))
  const replicationOn = cluster.replicationMode !== "none" && members.length > 1

  const pairs: Array<{ source: ClusterMember; dest: ClusterMember }> = []
  if (replicationOn) {
    for (const source of members) {
      for (const dest of members) {
        if (source.registryId !== dest.registryId) pairs.push({ source, dest })
      }
    }
  }

  const wanted = new Set(pairs.map((p) => `${p.source.registryId}:${p.dest.registryId}`))
  const existing = await prisma.replicationLink.findMany({
    where: {
      OR: [
        { sourceRegistryId: { in: [...memberIds] } },
        { destRegistryId: { in: [...memberIds] } },
      ],
    },
  })

  let removed = 0
  for (const link of existing) {
    if (wanted.has(`${link.sourceRegistryId}:${link.destRegistryId}`)) continue
    await removeReplicationLink(link.id)
    removed += 1
  }

  const trigger = triggerFor(cluster.replicationMode, cluster.replicationCron)

  // Grouped by source so one unreachable Harbor only costs its own outgoing links.
  const bySource = new Map<string, ClusterMember[]>()
  for (const pair of pairs) {
    const list = bySource.get(pair.source.registryId) ?? []
    list.push(pair.dest)
    bySource.set(pair.source.registryId, list)
  }

  const sources = members.filter((m) => bySource.has(m.registryId))

  // Sources in parallel, destinations of one source in sequence: the per-source order is what
  // keeps a single Harbor from taking N-1 concurrent administrative writes.
  const runSource = async (source: ClusterMember) => {
    let succeeded = 0
    let failed = 0

    for (const dest of bySource.get(source.registryId)!) {
      try {
        await applyReplicationLink(source, dest, trigger, { force })
        succeeded += 1
      } catch (err) {
        const error = errorMessage(err)
        logger.warn("Replication edge failed", {
          sourceRegistryId: source.registryId,
          destRegistryId: dest.registryId,
          error,
        })
        await recordEdgeFailure(source.registryId, dest.registryId, error)
        failed += 1
      }
    }

    return { succeeded, failed }
  }
  const outcomes = []
  for (let offset = 0; offset < sources.length; offset += 3) {
    outcomes.push(...await fanOut(sources.slice(offset, offset + 3), runSource))
  }

  let succeeded = 0
  let failed = 0
  for (const outcome of outcomes) {
    if (outcome.ok && outcome.value) {
      succeeded += outcome.value.succeeded
      failed += outcome.value.failed
      // One entry per source however many of its edges failed — enqueue() collapses duplicates
      // anyway, and the replay is a whole-cluster sync either way.
      if (outcome.value.failed > 0) {
        await enqueue({ registryId: outcome.member.registryId, kind: "REPLICATION_SYNC" })
      }
      continue
    }

    // The callback itself threw, which the per-edge catch above should make impossible —
    // a database write failing, say. Attribute it to the source's edges and queue a replay.
    const error = outcome.error ?? "Unknown error"
    const dests = bySource.get(outcome.member.registryId) ?? []
    for (const dest of dests) {
      await recordEdgeFailure(outcome.member.registryId, dest.registryId, error)
    }
    failed += dests.length
    await enqueue({ registryId: outcome.member.registryId, kind: "REPLICATION_SYNC" })
  }

  return { desired: pairs.length, succeeded, failed, removed }
}

// Durable request: the worker tracks the accepted execution through its terminal result.
export async function catchUpMember(registryId: string): Promise<void> {
  await prisma.replicationLink.updateMany({
    where: { destRegistryId: registryId },
    data: { catchUpRequested: true, nextAttemptAt: new Date() },
  })
}

// Tears down every link touching a registry — used when it leaves a cluster or is deleted.
export async function unlinkRegistry(registryId: string): Promise<void> {
  return withReplicationLock(() => runUnlinkRegistry(registryId))
}

async function runUnlinkRegistry(registryId: string): Promise<void> {
  const links = await prisma.replicationLink.findMany({
    where: { OR: [{ sourceRegistryId: registryId }, { destRegistryId: registryId }] },
  })
  for (const link of links) {
    await removeReplicationLink(link.id)
  }
}
