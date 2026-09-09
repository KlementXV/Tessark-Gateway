import { RegistryRole } from "@/generated/prisma/client"
import { logger } from "@/lib/logger"
import { prisma } from "@/lib/prisma"
import { NotManagedError, type ClusterMember } from "./members"

// Fan-out is best-effort by design: an action applies to every member that answers, and the
// members that didn't are parked in PendingOperation for the reconciler to replay once they
// are reachable again (see ./reconcile.ts). The alternative — rolling back everywhere when
// one Harbor is down — would let a single unhealthy member block the whole cluster.

export type OperationKind =
  | "PROJECT_CREATE"
  | "PROJECT_DELETE"
  | "ROBOT_CREATE"
  | "ROBOT_DELETE"
  | "MEMBER_ADD"
  | "MEMBER_REMOVE"
  | "GROUP_ADD"
  | "GROUP_REMOVE"
  | "RETENTION_UPSERT"
  | "QUOTA_UPDATE"
  | "SCAN_POLICY_UPDATE"
  | "ARTIFACT_DELETE"
  | "REPLICATION_SYNC"

export interface MemberOutcome<T> {
  member: ClusterMember
  ok: boolean
  value?: T
  error?: string
  /** The thrown value behind `error`, kept so callers can branch on its type. */
  reason?: unknown
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// Members are independent Harbors, so they are driven in parallel; one failing never
// prevents the others from being attempted.
export async function fanOut<T>(
  members: ClusterMember[],
  run: (member: ClusterMember) => Promise<T>
): Promise<MemberOutcome<T>[]> {
  return Promise.all(
    members.map(async (member) => {
      try {
        return { member, ok: true, value: await run(member) }
      } catch (err) {
        const error = errorMessage(err)
        // Absorbed by design (see the module note above) — the caller queues a PendingOperation
        // rather than surfacing this to the user, so a log line is the only trace it leaves.
        logger.warn("Harbor call failed", { registryId: member.registryId, baseUrl: member.conn.baseUrl, error })
        return { member, ok: false, error, reason: err }
      }
    })
  )
}

export interface EnqueueInput {
  registryId: string
  kind: OperationKind
  projectId?: string | null
  robotAccountId?: string | null
  payload?: Record<string, unknown>
}

// Queues work owed to one member. Two rules keep the queue from growing unbounded or
// replaying nonsense:
//
//   * Identical entries collapse — re-running an action against a member that is still down
//     must not stack up N copies of the same create.
//   * A delete supersedes the pending create but must still be replayed: a queued create
//     may be an update, or a remote success whose response was lost.
export async function enqueue(input: EnqueueInput): Promise<void> {
  // Every queued operation is an administrative write replayed later by the reconciler, so
  // this is the narrowest place to stop one from ever being owed to a Harbor the Gateway does
  // not administer. Checked here rather than at each of the dozen call sites: a row that
  // reaches the queue is a row that will eventually be executed.
  const registry = await prisma.registry.findUnique({
    where: { id: input.registryId },
    select: { name: true, role: true },
  })
  if (registry && registry.role !== RegistryRole.MANAGED) {
    throw new NotManagedError(registry.name)
  }

  const target = {
    registryId: input.registryId,
    projectId: input.projectId ?? null,
    robotAccountId: input.robotAccountId ?? null,
  }

  if (input.kind === "PROJECT_DELETE") {
    // Cancel stale creation intent, but preserve the remote deletion even after a timeout.
    const scope = { registryId: target.registryId, projectId: target.projectId }
    await prisma.pendingOperation.deleteMany({ where: { ...scope, kind: "PROJECT_CREATE" } })

    // Deliberately not deduplicated on projectId: the Gateway row is deleted right after
    // this, so the entry keeps its target only in `payload.harborProjectId`, and two
    // deletes queued for the same member are two different Harbor projects.
    await prisma.pendingOperation.create({
      data: {
        registryId: target.registryId,
        kind: input.kind,
        payload: JSON.stringify(input.payload ?? {}),
      },
    })
    return
  }

  // Grants — to a person or to a directory group — have no column of their own to key on: the
  // subject lives in the payload. The generic dedup below keys on (registry, project, robot,
  // kind), so it would collapse two grants to *different* subjects into one entry and replay
  // only the last, leaving the other holding a Gateway-side row for access it never received
  // on that Harbor. Both rules are reproduced here, scoped to the subject instead.
  const GRANT_KINDS: Partial<Record<OperationKind, { pair: OperationKind[]; subject: string }>> = {
    MEMBER_ADD: { pair: ["MEMBER_ADD", "MEMBER_REMOVE"], subject: "username" },
    MEMBER_REMOVE: { pair: ["MEMBER_ADD", "MEMBER_REMOVE"], subject: "username" },
    GROUP_ADD: { pair: ["GROUP_ADD", "GROUP_REMOVE"], subject: "groupName" },
    GROUP_REMOVE: { pair: ["GROUP_ADD", "GROUP_REMOVE"], subject: "groupName" },
  }

  const grant = GRANT_KINDS[input.kind]
  if (grant) {
    const [, removeKind] = grant.pair
    const subject = input.payload?.[grant.subject]
    const scope = { registryId: target.registryId, projectId: target.projectId }
    const sameSubject = (op: { kind: string; payload: string }) =>
      parsePayload(op.payload)[grant.subject] === subject

    const queued = await prisma.pendingOperation.findMany({
      where: { ...scope, kind: { in: grant.pair } },
    })
    const forThisSubject = queued.filter(sameSubject)

    if (input.kind === removeKind) {
      // ADD also represents role changes: the remote grant may already exist.
      await prisma.pendingOperation.deleteMany({
        where: { id: { in: forThisSubject.map((op) => op.id) } },
      })
    } else {
      const existing = forThisSubject.find((op) => op.kind === input.kind)
      if (existing) {
        await prisma.pendingOperation.update({
          where: { id: existing.id },
          data: { payload: JSON.stringify(input.payload ?? {}) },
        })
        return
      }
      // An add supersedes a queued removal of the same subject on the same member.
      await prisma.pendingOperation.deleteMany({
        where: { id: { in: forThisSubject.filter((op) => op.kind === removeKind).map((o) => o.id) } },
      })
    }

    await prisma.pendingOperation.create({
      data: {
        registryId: target.registryId,
        kind: input.kind,
        projectId: target.projectId,
        payload: JSON.stringify(input.payload ?? {}),
      },
    })
    return
  }

  // An artifact delete carries its subject — repository and reference — in the payload, so the
  // generic dedup below would collapse two deletes of *different* images into one entry and
  // replay only the last. The image the reconciler then never removes would come back on the
  // next replication pass, which is precisely the failure this queue exists to prevent.
  if (input.kind === "ARTIFACT_DELETE") {
    const scope = { registryId: target.registryId, projectId: target.projectId, kind: input.kind }
    const queued = await prisma.pendingOperation.findMany({ where: scope })
    const same = queued.find((op) => {
      const payload = parsePayload(op.payload)
      return (
        payload.repo === input.payload?.repo && payload.reference === input.payload?.reference
      )
    })
    if (same) return

    await prisma.pendingOperation.create({
      data: {
        registryId: target.registryId,
        kind: input.kind,
        projectId: target.projectId,
        payload: JSON.stringify(input.payload ?? {}),
      },
    })
    return
  }

  if (input.kind === "ROBOT_DELETE") {
    // Scoped to this robot, so unrelated queued work for the member survives.
    const scope = { registryId: target.registryId, robotAccountId: target.robotAccountId }
    await prisma.pendingOperation.deleteMany({ where: { ...scope, kind: "ROBOT_CREATE" } })
  } else {
    const existing = await prisma.pendingOperation.findFirst({
      where: { ...target, kind: input.kind },
    })
    if (existing) {
      // Refresh the payload: the latest desired state is the one worth replaying.
      await prisma.pendingOperation.update({
        where: { id: existing.id },
        data: { payload: JSON.stringify(input.payload ?? {}) },
      })
      return
    }
  }

  await prisma.pendingOperation.create({
    data: {
      registryId: target.registryId,
      kind: input.kind,
      projectId: target.projectId,
      robotAccountId: target.robotAccountId,
      payload: JSON.stringify(input.payload ?? {}),
    },
  })
}

export function parsePayload(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}
