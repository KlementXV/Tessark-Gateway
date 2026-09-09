// Launching the skopeo Jobs that mirror an image into each of a transfer's destinations.
//
// Shared by the two callers that may start one — an admin creating a transfer straight away
// (POST /api/transfers) and an admin approving somebody's request
// (POST /api/transfers/[id]/approve) — so that "transferred directly" can never drift into
// meaning "transferred differently": same preconditions, same target selection, same job spec.
//
// One request fans out to one Job per TransferTarget. Destinations are independent: a project
// whose cluster is down does not stop the others from being mirrored, it just comes back
// FAILED with the reason on its own row.
import { pickWriteMember } from "@/lib/clusters/members"
import { getConfig } from "@/lib/config"
import { ensureTransferResources, TransferJobUnconfirmedError } from "@/lib/transfers/resources"
import { TransferLaunchError, withTransferLock } from "@/lib/transfers/lock"
export { TransferLaunchError } from "@/lib/transfers/lock"
import { logger } from "@/lib/logger"
import { getEnterpriseCaPem } from "@/lib/settings/enterprise-ca"
import {
  resolvePushCredentials,
  resolveSourceCredentials,
  type PushCredentials,
} from "@/lib/transfers/credentials"
import { buildDestinationImage } from "@/lib/transfers/image-ref"
import { buildSkopeoJobLabels, buildSkopeoJobSpec } from "@/lib/transfers/job-spec"
import { findMatchingRule } from "@/lib/transfers/rules"
import { parseSkopeoOverrides } from "@/lib/transfers/skopeo-overrides"
import { TRANSFERS_DISABLED_REASON } from "@/lib/transfers/messages"
import { refreshTransferStatus } from "@/lib/transfers/status"
import { prisma } from "@/lib/prisma"
import { resolveConnection, skopeoNeedsInsecure } from "@/lib/registries/resolve"
import type { RegistryConnection } from "@/lib/registries/types"
import { shortRepoName } from "@/lib/sources/repo"
import { RegistryRole, type Registry, type TransferRequest, type UpstreamSource } from "@/generated/prisma/client"

interface TargetOutcome {
  targetId: string
  jobName?: string
  error?: string
  status: number
}

/**
 * Starts the mirror jobs for `transferRequestId` on behalf of `actorUserId`.
 *
 * When no destination could be started at all, nothing is written and TransferLaunchError is
 * thrown: the request stays PENDING with its targets intact, so approving it later retries
 * the identical launch. As soon as one destination starts, the outcome is recorded per
 * target — the ones that failed keep their reason, and the request rolls up to RUNNING.
 */
async function launchTransferRequestInner(
  transferRequestId: string,
  actorUserId: string,
): Promise<TransferRequest> {
  if (!getConfig().k8sEnabled) {
    // Checked first, before touching the database: a disabled feature should never leave a
    // target half-attempted, and this is the one precondition every target would fail on
    // identically — no point looping through them to say so N times.
    throw new TransferLaunchError(TRANSFERS_DISABLED_REASON, 503)
  }

  const transferRequest = await prisma.transferRequest.findUnique({
    where: { id: transferRequestId },
    include: {
      source: true,
      sourceRegistry: true,
      targets: {
        include: {
          project: {
            include: {
              robotAccounts: {
                orderBy: { createdAt: "desc" },
                take: 1,
                include: { placements: true },
              },
            },
          },
          destRegistry: true,
        },
      },
    },
  })
  if (!transferRequest) throw new TransferLaunchError("Not found", 404)

  if (transferRequest.status === "REJECTED") throw new TransferLaunchError("Transfer request was rejected", 409)

  const pending = transferRequest.targets.filter((target) => target.status === "PENDING")
  if (pending.length === 0) {
    throw new TransferLaunchError("This request has no destination left to start.", 400)
  }

  const outcomes: TargetOutcome[] = []
  for (const target of pending) {
    outcomes.push(await launchTarget(target, transferRequest))
  }

  const started = outcomes.filter((outcome) => outcome.jobName)
  if (started.length === 0) {
    // Nothing was written — every destination refused for the same class of reason, and the
    // request is exactly as retryable as it was a moment ago.
    const first = outcomes[0]
    throw new TransferLaunchError(first.error ?? "Failed to launch the mirror job", first.status)
  }

  await Promise.all(
    outcomes.map((outcome) =>
      prisma.transferTarget.update({
        where: { id: outcome.targetId },
        data: outcome.jobName
          ? { status: "RUNNING", k8sJobName: outcome.jobName, errorMessage: outcome.error ?? null }
          : { status: "FAILED", errorMessage: outcome.error },
      }),
    ),
  )

  await prisma.transferRequest.update({
    where: { id: transferRequestId },
    data: { reviewedByUserId: actorUserId, reviewedAt: new Date() },
  })

  const refreshed = await refreshTransferStatus(transferRequestId)
  return refreshed ?? transferRequest
}

type PendingTarget = {
  id: string
  destRegistryId: string | null
  targetRepo: string | null
  destProjectName: string | null
  // Exactly one of these is set — see the TransferTarget comment in prisma/schema.prisma.
  project: {
    id: string
    name: string
    status: string
    clusterId: string
    robotAccounts: { name: string; encryptedSecret: string; placements: { registryId: string; encryptedSecret: string | null }[] }[]
  } | null
  destRegistry: Registry | null
}

/**
 * Where one target actually writes, and with what.
 *
 * Both forms of a destination collapse into this before anything is built: the Harbor to push
 * to, the project name there, and the credentials that may push into it. Everything past this
 * point is identical whether the image is landing in a project the Gateway owns or being
 * delivered to a Harbor it does not.
 */
interface ResolvedDestination {
  conn: RegistryConnection
  projectName: string
  push: PushCredentials
}

interface PendingTransfer {
  id: string
  sourceId: string | null
  sourceRegistryId: string | null
  sourceImage: string
  sourceRepo: string
  sourceTag: string
  sourceDigest: string | null
  sourceProjectName: string | null
  useCustomCa: boolean
  source: UpstreamSource | null
  sourceRegistry: Registry | null
}

async function launchTarget(
  target: PendingTarget,
  transfer: PendingTransfer,
): Promise<TargetOutcome> {
  let destination: ResolvedDestination
  try {
    const resolved = await resolveDestination(target)
    if ("error" in resolved) return { targetId: target.id, ...resolved }
    destination = resolved
  } catch (err) {
    const error = err instanceof Error ? err.message : "Failed to resolve the destination"
    logger.error("Transfer destination unavailable", { targetId: target.id, error: err })
    return { targetId: target.id, status: 502, error }
  }

  // Left unset, the destination repository keeps the source's short name: "library/nginx"
  // transferred into project "apps" lands as apps/nginx.
  const targetRepo = target.targetRepo || shortRepoName(transfer.sourceRepo)
  const destImage = buildDestinationImage(
    destination.conn.baseUrl,
    destination.projectName,
    targetRepo,
    transfer.sourceTag,
  )
  // Jobs are named after the target, not the request: a request with three destinations would
  // otherwise try to create the same Job three times.
  const jobName = `transfer-${target.id}`.toLowerCase()
  const secretName = `${jobName}-creds`

  const secretData: Record<string, string> = {
    DEST_USERNAME: destination.push.username,
    DEST_PASSWORD: destination.push.secret,
  }
  // The enterprise CA (Policy › Enterprise CA) is instance-wide, so there is nothing per-end
  // to resolve here — only whether this transfer wants it.
  //
  // `useCustomCa` is the answer resolved when the request was written — the requester's switch
  // if they touched it, the instance default otherwise — so a retry or a late approval replays
  // that answer rather than today's setting. Turning it off does not weaken TLS: nothing here
  // ever adds `--tls-verify=false`, the copy simply runs against the public roots alone.
  // getEnterpriseCaPem() returns null while the beta flag is off, so a disabled instance has no
  // CA to hand out in the first place.
  const caPem = transfer.useCustomCa ? await getEnterpriseCaPem() : null
  const caData: Record<string, string> = caPem ? { "ca.crt": caPem } : {}

  // Only the flag is spliced into the command — the credentials themselves stay in the Secret
  // and reach the container as environment variables, never as literals in the pod spec.
  let sourceArgs = ""
  const credentials = resolveSourceCredentials(transfer)
  if (credentials?.kind === "basic") {
    secretData.SRC_USERNAME = credentials.username
    secretData.SRC_PASSWORD = credentials.secret
    sourceArgs = ' --src-creds="$SRC_USERNAME:$SRC_PASSWORD"'
  } else if (credentials?.kind === "token") {
    secretData.SRC_TOKEN = credentials.secret
    sourceArgs = ' --src-registry-token="$SRC_TOKEN"'
  }

  const labels = buildSkopeoJobLabels({ transferTargetId: target.id, transferRequestId: transfer.id })

  // The rule is re-resolved at launch rather than snapshotted at request time: its overrides
  // describe how this direction should run *now*, and an operator who raises a deadline after
  // a transfer failed on it expects the retry to use the new one. The permission the rule
  // granted was already checked when the request was written; this only reads its knobs.
  const rule = await findMatchingRule({
    sourceUpstreamId: transfer.sourceId,
    sourceRegistryId: transfer.sourceRegistryId,
    repo: transfer.sourceRepo,
    destRegistryId: target.destRegistryId,
    destProjectName: destination.projectName,
  })

  try {
    await ensureTransferResources({
      jobName,
      labels,
      secrets: [
        { name: secretName, data: secretData },
        ...(caPem ? [{ name: `${secretName}-ca`, data: caData }] : []),
      ],
      spec: buildSkopeoJobSpec({
        secretName,
        sourceImage: pinnedSourceImage(transfer),
        destImage,
        sourceArgs,
        labels,
        // The registry rows are the authority on this, not the rule: an operator who ticked
        // "insecure TLS" on a Harbor — or gave it an http:// URL — said it about that Harbor,
        // not about one direction.
        sourceInsecure: transfer.sourceRegistry
          ? skopeoNeedsInsecure(transfer.sourceRegistry)
          : false,
        destInsecure: skopeoNeedsInsecure(destination.conn),
        caPem,
        overrides: rule ? parseSkopeoOverrides(rule.skopeoOverrides) : {},
      }),
    })
  } catch (err) {
    const error = err instanceof Error ? err.message : "Failed to launch the mirror job"
    logger.error("Skopeo Job launch failed", { targetId: target.id, jobName, error: err })
    if (err instanceof TransferJobUnconfirmedError) return { targetId: target.id, jobName, status: 202, error }
    // Retain resources after uncertain writes; the next attempt inspects and adopts them.
    return { targetId: target.id, status: 502, error }
  }

  logger.info("Skopeo Job launched", { targetId: target.id, jobName, destImage })
  return { targetId: target.id, jobName, status: 200 }
}

/**
 * Turns a target's coordinate into a Harbor, a project name and the credentials to push with.
 *
 * A TargetOutcome-shaped refusal is returned rather than thrown for everything the requester
 * could act on — an inactive project, a cluster that is down, a delivery registry that was
 * disabled since the request was raised — so the message lands on that target's own row and
 * its siblings still go.
 */
async function resolveDestination(
  target: PendingTarget,
): Promise<ResolvedDestination | { status: number; error: string }> {
  // Delivery form: the Harbor is named outright, and so is the project on it. Nothing is
  // resolved through placements or robots, because the Gateway owns neither there.
  if (target.destRegistry) {
    const registry = target.destRegistry
    if (registry.role !== RegistryRole.DELIVERY) {
      // Only reachable if a registry was narrowed back to MANAGED after the request was
      // raised. Pushing with the admin credential is not what this form promises, so refuse.
      return {
        status: 409,
        error: `${registry.name} is no longer a delivery registry — raise the transfer again against one of its projects.`,
      }
    }
    if (!target.destProjectName) {
      return { status: 400, error: `No project was named on ${registry.name}.` }
    }

    const conn = resolveConnection(registry)
    if (!conn.username || !conn.secret) {
      // The credentials on the row are the *only* way in: there is no project robot and no
      // system robot on a Harbor we do not administer.
      return {
        status: 400,
        error: `${registry.name} has no stored credentials — add the account the Gateway should push with.`,
      }
    }

    return {
      conn,
      projectName: target.destProjectName,
      push: { username: conn.username, secret: conn.secret },
    }
  }

  const project = target.project
  if (!project) {
    // Both coordinates null: the project was deleted after the request was raised (the FK is
    // SetNull so the history survives), so there is nowhere left to write.
    return { status: 410, error: "This destination no longer exists." }
  }

  if (project.status !== "ACTIVE") {
    return { status: 400, error: `${project.name} must be active before transferring images into it` }
  }

  // One healthy member is enough: replication carries the mirrored image to its peers, so
  // the job doesn't have to push N times — and picking a live member keeps a single Harbor
  // being down from failing the mirror. Resolved before the credentials because which member
  // is written to is what decides which credentials work there.
  const writeMember = await pickWriteMember(project.clusterId, project.id)
  if (!writeMember) {
    return {
      status: 502,
      error: `No healthy Harbor in ${project.name}'s cluster is currently reachable — try again once one is back.`,
    }
  }

  const push = await resolvePushCredentials(project, writeMember)
  if (!push) {
    return {
      status: 400,
      error: `${project.name} has no robot account yet — create one first so Gateway can push the mirrored image.`,
    }
  }

  return { conn: writeMember.conn, projectName: project.name, push }
}

/**
 * The exact reference the Job reads from.
 *
 * When the source could be asked for a digest at request time, that digest is what travels —
 * not the tag. A tag is a moving pointer: it can be overwritten between the moment a reviewer
 * approves a transfer and the moment the Job runs, and delivering something other than what
 * was approved is precisely the failure this pinning exists to prevent. The destination is
 * still written under the tag, so what lands is named the way the requester asked for.
 *
 * Exported for its own tests: the host may carry a port, which is the case this gets wrong if
 * the tag is cut at the first colon.
 */
export function pinnedSourceImage(transfer: PendingTransfer): string {
  if (!transfer.sourceDigest) return transfer.sourceImage

  // sourceImage is host/repo:tag, and the host may carry a port — so the tag is cut at the
  // last colon *after* the last slash, never at the first colon in the string.
  const lastSlash = transfer.sourceImage.lastIndexOf("/")
  const lastColon = transfer.sourceImage.lastIndexOf(":")
  const withoutTag =
    lastColon > lastSlash ? transfer.sourceImage.slice(0, lastColon) : transfer.sourceImage
  return `${withoutTag}@${transfer.sourceDigest}`
}

export async function launchTransferRequest(transferRequestId: string, actorUserId: string): Promise<TransferRequest> {
  if (!getConfig().k8sEnabled) throw new TransferLaunchError(TRANSFERS_DISABLED_REASON, 503)
  return withTransferLock(transferRequestId, () => launchTransferRequestInner(transferRequestId, actorUserId))
}
