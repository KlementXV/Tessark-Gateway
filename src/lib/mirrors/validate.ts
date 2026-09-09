// Everything that must hold before a scheduled mirror row is written. Same job as
// src/lib/transfers/validate.ts, and it reuses the same policy check — a mirror is a transfer
// that repeats, so a direction the rules refuse once must not become allowed by asking for it
// every day instead.
//
// What it adds is the transport's own preconditions, which are not the same for the two: the
// harbor transport writes a policy *on* the destination Harbor and therefore needs one the
// Gateway administers, while the skopeo transport needs Kubernetes.
import { RegistryRole } from "@/generated/prisma/client"
import { getConfig } from "@/lib/config"
import { prisma } from "@/lib/prisma"
import { findHarborProjectIdByName } from "@/lib/registries/harbor"
import { resolveConnection } from "@/lib/registries/resolve"
import { findMatchingRule } from "@/lib/transfers/rules"
import {
  buildSourceImageRef,
  isRepoAllowed,
  normalizeRepoPath,
  parseAllowedRepos,
} from "@/lib/sources/repo"
import { TRANSFERS_DISABLED_REASON } from "@/lib/transfers/messages"
import type { MirrorCreateInput } from "./schema"

export class MirrorValidationError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

export interface ValidatedMirror {
  sourceId: string | null
  sourceRegistryId: string | null
  sourceProjectName: string | null
  sourceRepo: string
  sourceTag: string
  /** Only for the message an operator reads — the row stores the coordinates, not this. */
  sourceLabel: string
  projectId: string | null
  destRegistryId: string | null
  destProjectName: string | null
  targetRepo: string | null
}

export async function validateMirror(input: MirrorCreateInput): Promise<ValidatedMirror> {
  const source = input.sourceId
    ? await validateUpstreamSource(input.sourceId, input.repo, input.tag)
    : await validateRegistrySource(input.sourceRegistryId!, input.sourceProjectName!, input.repo)

  const destination = input.projectId
    ? await validateProjectDestination(input.projectId, input.transport)
    : await validateDeliveryDestination(input.destRegistryId!, input.destProjectName!, input.transport)

  if (input.transport === "harbor" && input.targetRepo) {
    // Harbor's replication cannot rename a repository, only flatten its path. Accepting the
    // field and dropping it would make the mirror land somewhere the operator did not ask for.
    throw new MirrorValidationError(
      "A Harbor-scheduled mirror cannot rename the repository — leave it empty, or use the Kubernetes transport.",
      400,
    )
  }
  if (input.transport === "skopeo" && !getConfig().k8sEnabled) {
    throw new MirrorValidationError(TRANSFERS_DISABLED_REASON, 503)
  }

  const rule = await findMatchingRule({
    sourceUpstreamId: source.sourceId,
    sourceRegistryId: source.sourceRegistryId,
    repo: source.sourceRepo,
    destRegistryId: destination.destRegistryId,
    destProjectName: destination.projectName,
  })
  if (!rule) {
    throw new MirrorValidationError(
      `No transfer rule allows ${source.sourceLabel} → ${destination.projectName}. Ask an admin to open this direction.`,
      403,
    )
  }
  // A rule demanding review is not a refusal here: the admin creating the mirror is exactly
  // who would approve each of its runs, and the row records who that was (createdByUserId).
  // What the rule still governs is the direction itself, which is what was checked above.

  return {
    ...source,
    sourceTag: input.tag,
    projectId: destination.projectId,
    destRegistryId: destination.destRegistryId,
    destProjectName: destination.destProjectName,
    targetRepo: input.targetRepo || null,
  }
}

type ValidatedSource = Pick<
  ValidatedMirror,
  "sourceId" | "sourceRegistryId" | "sourceProjectName" | "sourceRepo" | "sourceLabel"
>

async function validateUpstreamSource(
  sourceId: string,
  rawRepo: string,
  tag: string,
): Promise<ValidatedSource> {
  const source = await prisma.upstreamSource.findUnique({ where: { id: sourceId } })
  if (!source) throw new MirrorValidationError("That upstream source no longer exists.", 404)
  if (!source.enabled) {
    throw new MirrorValidationError(`${source.name} is no longer available to pull from.`, 403)
  }

  const repo = normalizeRepoPath(source.host, rawRepo)
  if (!repo) throw new MirrorValidationError("Repository path is required.", 400)

  const allowedRepos = parseAllowedRepos(source.allowedRepos)
  if (!isRepoAllowed(repo, allowedRepos)) {
    throw new MirrorValidationError(
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
    sourceRepo: repo,
    sourceLabel: buildSourceImageRef(source.host, repo, tag),
  }
}

// No digest is frozen and no artifact is looked up, unlike a transfer: a mirror is a standing
// instruction to follow a tag wherever it moves, so pinning what it points at today would
// defeat the entire feature.
async function validateRegistrySource(
  registryId: string,
  projectName: string,
  rawRepo: string,
): Promise<ValidatedSource> {
  const registry = await prisma.registry.findUnique({ where: { id: registryId } })
  if (!registry) throw new MirrorValidationError("That registry no longer exists.", 404)

  const repo = rawRepo.trim().replace(/^\/+|\/+$/g, "").toLowerCase()
  if (!repo) throw new MirrorValidationError("Repository path is required.", 400)

  // The repository is stored without the project prefix, exactly as a transfer stores it, so
  // that a rule's repoFilter means the same thing whichever of the two raised the copy.
  return {
    sourceId: null,
    sourceRegistryId: registry.id,
    sourceProjectName: projectName,
    sourceRepo: repo,
    sourceLabel: `${registry.name} · ${projectName}/${repo}`,
  }
}

interface ValidatedDestination {
  projectId: string | null
  destRegistryId: string | null
  destProjectName: string | null
  /** The project name on the destination Harbor, whichever form named it. */
  projectName: string
}

async function validateProjectDestination(
  projectId: string,
  transport: string,
): Promise<ValidatedDestination> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      id: true,
      name: true,
      status: true,
      cluster: { select: { registries: { select: { role: true } } } },
    },
  })
  if (!project) throw new MirrorValidationError("That project no longer exists.", 404)
  if (project.status !== "ACTIVE") {
    throw new MirrorValidationError(
      `${project.name} is not active yet — images can only be mirrored into an approved project.`,
      400,
    )
  }
  if (transport === "harbor") {
    const managed = project.cluster?.registries.filter((r) => r.role === RegistryRole.MANAGED) ?? []
    if (managed.length === 0) {
      throw new MirrorValidationError(
        `${project.name}'s cluster has no Harbor the Gateway administers, so no policy can be written there. Use the Kubernetes transport instead.`,
        400,
      )
    }
  }

  return {
    projectId: project.id,
    destRegistryId: null,
    destProjectName: null,
    projectName: project.name,
  }
}

async function validateDeliveryDestination(
  registryId: string,
  projectName: string,
  transport: string,
): Promise<ValidatedDestination> {
  const registry = await prisma.registry.findUnique({ where: { id: registryId } })
  if (!registry) throw new MirrorValidationError("That registry no longer exists.", 404)
  if (registry.role !== RegistryRole.DELIVERY) {
    throw new MirrorValidationError(
      `${registry.name} is not a delivery registry — pick one of its Gateway projects instead.`,
      400,
    )
  }
  if (transport === "harbor") {
    // The whole point of the DELIVERY role: the Gateway pushes images there and writes
    // nothing else. A replication policy is an object on that Harbor, which is theirs.
    throw new MirrorValidationError(
      `${registry.name} is a delivery registry — the Gateway never writes policies on it. Use the Kubernetes transport for this destination.`,
      400,
    )
  }

  const conn = resolveConnection(registry)
  if (!conn.username || !conn.secret) {
    throw new MirrorValidationError(
      `${registry.name} has no stored credentials — add the account the Gateway should push with.`,
      400,
    )
  }

  let harborProjectId: number | null
  try {
    harborProjectId = await findHarborProjectIdByName(conn, projectName)
  } catch (err) {
    throw new MirrorValidationError(
      `${registry.name} could not be reached to check its projects (${err instanceof Error ? err.message : "unknown error"}).`,
      502,
    )
  }
  if (harborProjectId === null) {
    throw new MirrorValidationError(
      `${registry.name} has no project named "${projectName}" — it has to be created there first.`,
      404,
    )
  }

  return {
    projectId: null,
    destRegistryId: registry.id,
    destProjectName: projectName,
    projectName,
  }
}
