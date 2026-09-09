// The client-facing shape of a scheduled mirror. Nothing sensitive crosses: no connection,
// no credential, and the transport's Harbor/Kubernetes object names are kept because an
// operator debugging with kubectl or Harbor's own UI needs to know what to look for.
import type { Prisma } from "@/generated/prisma/client"

export const mirrorInclude = {
  source: { select: { id: true, name: true, host: true } },
  sourceRegistry: { select: { id: true, name: true } },
  project: { select: { id: true, name: true } },
  destRegistry: { select: { id: true, name: true } },
  harborRegistry: { select: { id: true, name: true } },
} satisfies Prisma.ScheduledMirrorInclude

export type MirrorRow = Prisma.ScheduledMirrorGetPayload<{ include: typeof mirrorInclude }>

export interface PublicMirror {
  id: string
  name: string
  description: string | null
  /** "docker.io/library/nginx:latest" — what the run reads, as one reference. */
  sourceImage: string
  sourceName: string
  destination: string
  destinationHref: string | null
  schedule: string
  transport: string
  enabled: boolean
  /** Whether the schedule is installed on its transport right now. */
  applied: boolean
  lastAppliedAt: string | null
  lastError: string | null
  /** Where the transport put the object, for whoever goes looking with kubectl or in Harbor. */
  transportObject: string | null
}

function sourceImageOf(mirror: MirrorRow): string {
  const repo = mirror.sourceProjectName
    ? `${mirror.sourceProjectName}/${mirror.sourceRepo}`
    : mirror.sourceRepo
  const host = mirror.source?.host ?? mirror.sourceRegistry?.name ?? "?"
  return `${host}/${repo}:${mirror.sourceTag}`
}

// The same vocabulary describeDestination() uses for a transfer — a bare path for a project
// the Gateway owns, prefixed by the Harbor when the image leaves the estate.
function destinationOf(mirror: MirrorRow): string {
  const projectName = mirror.project?.name ?? mirror.destProjectName
  if (!projectName) return "—"
  const path = mirror.targetRepo ? `${projectName}/${mirror.targetRepo}` : projectName
  return mirror.destRegistry ? `${mirror.destRegistry.name} · ${path}` : path
}

export function toPublicMirror(mirror: MirrorRow): PublicMirror {
  return {
    id: mirror.id,
    name: mirror.name,
    description: mirror.description,
    sourceImage: sourceImageOf(mirror),
    sourceName: mirror.source?.name ?? mirror.sourceRegistry?.name ?? "—",
    destination: destinationOf(mirror),
    destinationHref: mirror.project
      ? `/projects/${mirror.project.id}`
      : mirror.destRegistry
        ? `/registries/${mirror.destRegistry.id}`
        : null,
    schedule: mirror.schedule,
    transport: mirror.transport,
    enabled: mirror.enabled,
    applied: mirror.applied,
    lastAppliedAt: mirror.lastAppliedAt?.toISOString() ?? null,
    lastError: mirror.lastError,
    transportObject:
      mirror.transport === "harbor"
        ? mirror.harborRegistry
          ? `${mirror.harborRegistry.name} · policy #${mirror.harborPolicyId ?? "?"}`
          : null
        : mirror.k8sCronJobName,
  }
}
