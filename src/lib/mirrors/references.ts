import { prisma } from "@/lib/prisma"

// Which scheduled mirrors stand in the way of deleting something they point at.
//
// The schema refuses these deletes outright (ScheduledMirror's four FKs are Restrict), which
// is the guarantee; this is the sentence the operator reads instead of a foreign-key error.
// Both halves are needed: without the constraint a future call site would cascade a mirror
// away and leave its Harbor policy or CronJob running, and without this the person deleting a
// project would be told only that the database said no.

export interface MirrorReference {
  id: string
  name: string
  /** "harbor" | "skopeo" — the operator's next move differs, so it is said here. */
  transport: string
  /** Whether the transport object is currently installed and therefore still firing. */
  applied: boolean
}

export type MirrorReferenceScope =
  | { projectId: string }
  | { registryId: string }
  | { sourceId: string }

function whereFor(scope: MirrorReferenceScope) {
  if ("projectId" in scope) return { projectId: scope.projectId }
  // A registry can be any of three things to a mirror: where the image is read from, where it
  // is pushed, or — on the harbor transport — the Harbor whose replication policy runs it.
  // The third is SetNull rather than Restrict (a mirror survives losing the Harbor that hosted
  // its policy, it just needs reinstalling), so it is not listed as a blocker here.
  if ("registryId" in scope) {
    return {
      OR: [{ sourceRegistryId: scope.registryId }, { destRegistryId: scope.registryId }],
    }
  }
  return { sourceId: scope.sourceId }
}

export async function mirrorsBlockingDelete(scope: MirrorReferenceScope): Promise<MirrorReference[]> {
  return prisma.scheduledMirror.findMany({
    where: whereFor(scope),
    select: { id: true, name: true, transport: true, applied: true },
    orderBy: { name: "asc" },
  })
}

/**
 * The refusal, in the API's language (English — machine contract, see CLAUDE.md).
 *
 * It names the mirrors rather than counting them: "delete the mirrors first" is not actionable
 * when the reader has no idea which ones, and the whole point of refusing is that they go and
 * delete them properly, through DELETE /api/mirrors/[id], which uninstalls the schedule.
 */
export function mirrorBlockMessage(subject: string, mirrors: MirrorReference[]): string {
  const names = mirrors.map((mirror) => mirror.name).join(", ")
  const one = mirrors.length === 1
  // "points at" rather than naming the direction: the same sentence has to be true of a
  // project and a registry (either end) and an upstream source (the source end only).
  return `${mirrors.length} scheduled ${one ? "mirror" : "mirrors"} still ${one ? "points" : "point"} at this ${subject}: ${names}. Delete ${one ? "it" : "them"} first — deleting a mirror is what uninstalls its Harbor policy or Kubernetes CronJob, and removing this would leave the schedule running with nothing to stop it.`
}
