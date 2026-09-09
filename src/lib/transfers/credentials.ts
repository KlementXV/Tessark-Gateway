// The two credentials a mirror needs: one to read the source, one to push into the
// destination. Shared by the one-shot transfer (launch.ts) and the scheduled mirror
// (src/lib/mirrors/skopeo-transport.ts) — a repeat of a transfer must authenticate exactly
// like the transfer it repeats, and duplicating this is how "daily" would quietly end up
// pushing with a different account than "now".
import { decryptSecret } from "@/lib/crypto"
import { ensureSystemRobot, type PushCredentials } from "@/lib/clusters/system-robot"
import type { ClusterMember } from "@/lib/clusters/members"
import { resolveConnection } from "@/lib/registries/resolve"
import { sourceCredentials, type SourceCredentials } from "@/lib/sources/service"
import type { Registry, UpstreamSource } from "@/generated/prisma/client"

export type { PushCredentials, SourceCredentials }

/** The robot accounts of a destination project, in the shape both callers already load. */
export interface ProjectPushContext {
  name: string
  robotAccounts: Array<{
    name: string
    encryptedSecret: string
    placements: Array<{ registryId: string; encryptedSecret: string | null }>
  }>
}

/**
 * The credentials the skopeo job pushes with into a Gateway-managed project, preferring the
 * project's own robot.
 *
 * A project robot is the credential of record: it is scoped to that one project, it is what
 * the project's managers see and rotate, and its permissions are theirs. The Gateway's system
 * robot is only a fallback for projects that have none — without it, mirroring into a project
 * meant creating a robot by hand first, and a queued request could not be approved until
 * somebody did. Null means neither is available, which is a request the caller should refuse
 * rather than retry.
 *
 * Neither exists on a delivery registry: there the credentials on the Registry row are the
 * only way in, and the caller resolves them itself.
 */
export async function resolvePushCredentials(
  project: ProjectPushContext,
  writeMember: ClusterMember,
): Promise<PushCredentials | null> {
  const robot = project.robotAccounts[0]
  if (robot) {
    // The stored secret is normally cluster-wide, but a member that refused the alignment
    // PATCH keeps its own — in which case that member's placement holds the one that works
    // there.
    const placementSecret = robot.placements.find(
      (placement) => placement.registryId === writeMember.registryId,
    )?.encryptedSecret
    return {
      username: `robot$${project.name}+${robot.name}`,
      secret: decryptSecret(placementSecret ?? robot.encryptedSecret),
    }
  }

  return ensureSystemRobot(writeMember)
}

/**
 * Credentials for the read side of the copy, whichever form the source took.
 *
 * A registry source uses the account stored on its own row — the same one every other Harbor
 * call goes through. It is basic auth in every case: Harbor's own API takes a username and a
 * secret, and a robot account is just a username with a long name.
 */
export function resolveSourceCredentials(source: {
  source: UpstreamSource | null
  sourceRegistry: Registry | null
}): SourceCredentials | null {
  if (source.source) return sourceCredentials(source.source)
  if (!source.sourceRegistry) return null

  const conn = resolveConnection(source.sourceRegistry)
  if (!conn.username || !conn.secret) return null
  return { kind: "basic", username: conn.username, secret: conn.secret }
}
