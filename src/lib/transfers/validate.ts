// Everything that must hold before a transfer request row is written: the source is one the
// Gateway holds and the requester may read, the repository is inside that source's allowlist,
// and every destination is one they may write to and that actually exists.
//
// Deliberately not in the zod schema — all of it needs the database, and a rejection here has
// to say *which* rule was broken, which a parse error cannot.
import type { Session } from "next-auth"

import { RegistryRole, Role } from "@/generated/prisma/client"
import { hasRole } from "@/lib/auth/guard"
import { prisma } from "@/lib/prisma"
import { findMatchingRule } from "./rules"
import { findHarborProjectIdByName, getHarborArtifactDigest } from "@/lib/registries/harbor"
import { resolveConnection } from "@/lib/registries/resolve"
import {
  buildSourceImageRef,
  isRepoAllowed,
  normalizeRepoPath,
  parseAllowedRepos,
} from "@/lib/sources/repo"
import type { TransferRequestCreateInput } from "./schema"

export class TransferValidationError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

// A destination that survived validation, in the storage shape TransferTarget expects.
export interface ValidatedDestination {
  projectId: string | null
  destRegistryId: string | null
  destProjectName: string | null
  targetRepo: string | null
}

export interface ValidatedTransfer {
  // Exactly one of the two source forms, mirroring the columns on TransferRequest.
  sourceId: string | null
  sourceRegistryId: string | null
  sourceProjectName: string | null
  /** The source row, whichever form it took — used for the notification wording. */
  sourceName: string
  repo: string
  tag: string
  sourceImage: string
  /** The digest that tag pointed at, when the source could be asked. See TransferRequest. */
  sourceDigest: string | null
  targets: ValidatedDestination[]
  /**
   * Whether any destination is governed by a rule demanding review.
   *
   * One request, one decision: a request landing in three places cannot be half-approved, so
   * if any of its destinations needs review the whole request waits. The alternative — some
   * targets starting while others queue — would make the request's aggregate status a lie.
   */
  requiresApproval: boolean
}

// The half of a validated request that describes where the image comes from.
type ValidatedSource = Pick<
  ValidatedTransfer,
  "sourceId" | "sourceRegistryId" | "sourceProjectName" | "sourceName" | "repo" | "sourceImage" | "sourceDigest"
>

export async function validateTransferRequest(
  input: TransferRequestCreateInput,
  session: Session,
  // Trusted, server-resolved artifact snapshot. Never populated from the public schema.
  options: { pinnedDigest?: string } = {},
): Promise<ValidatedTransfer> {
  const source = input.sourceId
    ? await validateUpstreamSource(input.sourceId, input.repo, input.tag)
    : await validateRegistrySource(
        input.sourceRegistryId!,
        input.sourceProjectName!,
        input.repo,
        input.tag,
        session,
        !options.pinnedDigest,
      )

  // Naming the same destination twice means the same thing as naming it once. Deduped on the
  // resolved coordinate rather than on the raw entry, so "project X" and "project X with no
  // repo override" collapse the way a reader expects.
  const seen = new Set<string>()
  const targets: ValidatedDestination[] = []
  for (const target of input.targets) {
    const key =
      "projectId" in target
        ? `project:${target.projectId}`
        : `registry:${target.destRegistryId}:${target.destProjectName}`
    if (seen.has(key)) continue
    seen.add(key)
    targets.push(
      "projectId" in target
        ? {
            projectId: target.projectId,
            destRegistryId: null,
            destProjectName: null,
            targetRepo: target.targetRepo || null,
          }
        : {
            projectId: null,
            destRegistryId: target.destRegistryId,
            destProjectName: target.destProjectName,
            targetRepo: target.targetRepo || null,
          },
    )
  }

  await validateProjectDestinations(targets, session)
  await validateDeliveryDestinations(targets)
  const requiresApproval = await validateAgainstRules(source, targets)

  return { ...source, sourceDigest: options.pinnedDigest ?? source.sourceDigest, tag: input.tag, targets, requiresApproval }
}

// An upstream host an admin approved, narrowed by its own repository allowlist. The host is
// never user input, which is what makes the allowlist meaningful.
async function validateUpstreamSource(
  sourceId: string,
  rawRepo: string,
  tag: string,
): Promise<ValidatedSource> {
  const source = await prisma.upstreamSource.findUnique({ where: { id: sourceId } })
  if (!source) throw new TransferValidationError("That upstream source no longer exists.", 404)
  if (!source.enabled) {
    throw new TransferValidationError(`${source.name} is no longer available to pull from.`, 403)
  }

  const repo = normalizeRepoPath(source.host, rawRepo)
  if (!repo) throw new TransferValidationError("Repository path is required.", 400)

  const allowedRepos = parseAllowedRepos(source.allowedRepos)
  if (!isRepoAllowed(repo, allowedRepos)) {
    throw new TransferValidationError(
      allowedRepos.length === 0
        ? `${source.name} has no allowed repositories configured — ask an admin to set them.`
        : `${repo} is outside what ${source.name} allows (${allowedRepos.join(", ")}).`,
      403,
    )
  }

  return {
    sourceId: source.id,
    sourceRegistryId: null,
    sourceProjectName: null,
    sourceName: source.name,
    repo,
    sourceImage: buildSourceImageRef(source.host, repo, tag),
    // An arbitrary upstream host is not something the Gateway can interrogate for a digest —
    // it holds no credentials for a v2 API it never talks to directly. The tag is what the
    // Job gets, and what a moving tag does between approval and launch is a known limit of
    // this form. See TransferRequest.sourceDigest.
    sourceDigest: null,
  }
}

/**
 * A project on a Harbor the Gateway already knows — the form that makes "take what the DMZ
 * holds and put it on the cluster" expressible.
 *
 * Reading is gated on the same footing as viewing the registry's contents: ADMIN, or
 * membership of the corresponding Gateway project when the registry is a managed one. A
 * delivery registry has no Gateway-side membership to consult, so it is admin-only.
 */
async function validateRegistrySource(
  registryId: string,
  projectName: string,
  rawRepo: string,
  tag: string,
  session: Session,
  resolveDigest = true,
): Promise<ValidatedSource> {
  const registry = await prisma.registry.findUnique({ where: { id: registryId } })
  if (!registry) throw new TransferValidationError("That registry no longer exists.", 404)

  const repo = rawRepo.trim().replace(/^\/+|\/+$/g, "").toLowerCase()
  if (!repo) throw new TransferValidationError("Repository path is required.", 400)

  if (!hasRole(session, Role.ADMIN)) {
    if (registry.role !== RegistryRole.MANAGED) {
      throw new TransferValidationError(
        `Only an admin can transfer images out of ${registry.name}.`,
        403,
      )
    }
    const project = await prisma.project.findFirst({
      where: {
        name: projectName,
        cluster: { registries: { some: { id: registry.id } } },
        OR: [
          { isPublic: true },
          { ownerUserId: session.user.id },
          { members: { some: { userId: session.user.id } } },
        ],
      },
      select: { id: true },
    })
    if (!project) {
      throw new TransferValidationError(
        `You need access to ${projectName} on ${registry.name} to transfer an image out of it.`,
        403,
      )
    }
  }

  const conn = resolveConnection(registry)
  const host = new URL(conn.baseUrl).host
  const sourceImage = `${host}/${projectName}/${repo}:${tag}`

  // Freezing the digest is the point of asking a Harbor at all: between the moment a reviewer
  // approves a transfer and the moment the Job runs, the tag may have been overwritten. A
  // missing or unreadable digest must refuse the request rather than fall back to a moving
  // tag. Resolve the tag directly: listing the first 100 artifacts misses older images.
  let sourceDigest: string | null = null
  try {
    if (resolveDigest) sourceDigest = await getHarborArtifactDigest(conn, projectName, repo, tag)
  } catch (err) {
    throw new TransferValidationError(
      `${registry.name} could not be asked for ${projectName}/${repo} (${err instanceof Error ? err.message : "unknown error"}).`,
      502,
    )
  }
  if (resolveDigest && !sourceDigest) {
    throw new TransferValidationError(
      `${projectName}/${repo}:${tag} was not found on ${registry.name}.`,
      404,
    )
  }

  return {
    sourceId: null,
    sourceRegistryId: registry.id,
    sourceProjectName: projectName,
    sourceName: registry.name,
    repo,
    sourceImage,
    sourceDigest,
  }
}

// Standing to write into a Gateway-managed project, and the project being ready to receive.
async function validateProjectDestinations(
  targets: ValidatedDestination[],
  session: Session,
): Promise<void> {
  const projectIds = targets
    .map((target) => target.projectId)
    .filter((id): id is string => id !== null)
  if (projectIds.length === 0) return

  const projects = await prisma.project.findMany({
    where: { id: { in: projectIds } },
    select: {
      id: true,
      name: true,
      status: true,
      isPublic: true,
      ownerUserId: true,
      members: { select: { userId: true, role: true } },
    },
  })
  const byId = new Map(projects.map((project) => [project.id, project]))
  const isAdmin = hasRole(session, Role.ADMIN)

  for (const id of projectIds) {
    const project = byId.get(id)
    if (!project) throw new TransferValidationError("One of the destination projects no longer exists.", 404)

    // Deliberately stricter than loadProjectForAccess: seeing a project is not standing to
    // write into it. Mirroring an image puts bytes in the project, spends its quota and
    // publishes a tag under its name, so it takes the same footing Harbor demands to push —
    // which a GUEST does not have, and a non-member of a *public* project has even less of.
    // Admin approval still gates the actual mirror; this only decides who may ask.
    const membership = project.members.find((member) => member.userId === session.user.id)
    const canReach =
      isAdmin ||
      project.ownerUserId === session.user.id ||
      (membership !== undefined && membership.role !== "GUEST")
    if (!canReach) {
      throw new TransferValidationError(
        `You need write access to ${project.name} to mirror an image into it.`,
        403,
      )
    }

    if (project.status !== "ACTIVE") {
      throw new TransferValidationError(
        `${project.name} is not active yet — images can only be mirrored into an approved project.`,
        400,
      )
    }
  }
}

/**
 * Preflight for every delivery destination: the registry is one, it is reachable, and the
 * project the requester named actually exists on it.
 *
 * The Gateway never creates a project on a Harbor it does not administer, so a name that is
 * not there is a dead end — and one worth reporting now. Left to the Job, the same mistake
 * surfaces thirty seconds later as a skopeo exit code in a pod that no longer exists.
 */
async function validateDeliveryDestinations(targets: ValidatedDestination[]): Promise<void> {
  const deliveries = targets.filter((target) => target.destRegistryId !== null)
  if (deliveries.length === 0) return

  const registries = await prisma.registry.findMany({
    where: { id: { in: deliveries.map((target) => target.destRegistryId!) } },
  })
  const byId = new Map(registries.map((registry) => [registry.id, registry]))

  for (const target of deliveries) {
    const registry = byId.get(target.destRegistryId!)
    if (!registry) {
      throw new TransferValidationError("One of the destination registries no longer exists.", 404)
    }
    if (registry.role !== RegistryRole.DELIVERY) {
      throw new TransferValidationError(
        `${registry.name} is not a delivery registry — pick one of its Gateway projects instead.`,
        400,
      )
    }

    const conn = resolveConnection(registry)
    let harborProjectId: number | null
    try {
      harborProjectId = await findHarborProjectIdByName(conn, target.destProjectName!)
    } catch (err) {
      throw new TransferValidationError(
        `${registry.name} could not be reached to check its projects (${err instanceof Error ? err.message : "unknown error"}).`,
        502,
      )
    }
    if (harborProjectId === null) {
      throw new TransferValidationError(
        `${registry.name} has no project named "${target.destProjectName}" — it has to be created there first.`,
        404,
      )
    }
  }
}

/**
 * Checks every destination against the policy, and reports whether any of them needs review.
 *
 * Default deny: a destination with no matching rule is refused outright, naming the direction
 * so the requester can ask for it to be opened rather than guessing why an obviously reachable
 * Harbor was rejected.
 */
async function validateAgainstRules(
  source: ValidatedSource,
  targets: ValidatedDestination[],
): Promise<boolean> {
  // A managed project's name is what the rule's projectFilter is matched against, so the
  // names are resolved once rather than per rule lookup.
  const projectIds = targets
    .map((target) => target.projectId)
    .filter((id): id is string => id !== null)
  const projects = projectIds.length
    ? await prisma.project.findMany({
        where: { id: { in: projectIds } },
        select: { id: true, name: true },
      })
    : []
  const projectNameById = new Map(projects.map((project) => [project.id, project.name]))

  let requiresApproval = false
  for (const target of targets) {
    const destProjectName = target.projectId
      ? projectNameById.get(target.projectId)
      : target.destProjectName
    if (!destProjectName) {
      throw new TransferValidationError("One of the destinations no longer exists.", 404)
    }

    const rule = await findMatchingRule({
      sourceUpstreamId: source.sourceId,
      sourceRegistryId: source.sourceRegistryId,
      repo: source.repo,
      destRegistryId: target.destRegistryId,
      destProjectName,
    })
    if (!rule) {
      throw new TransferValidationError(
        `No transfer rule allows ${source.sourceName} → ${destProjectName}. Ask an admin to open this direction.`,
        403,
      )
    }
    if (rule.requiresApproval) requiresApproval = true
  }

  return requiresApproval
}
