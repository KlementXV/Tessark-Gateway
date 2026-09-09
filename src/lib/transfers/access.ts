// Who may look at a transfer request. A request spans several destinations, so there is no
// single project to defer to: whoever asked for it can follow it, and so can anyone who can
// see any of the *managed* projects it lands in.
//
// A destination on a delivery registry grants nobody visibility: there is no membership to
// check on a Harbor the Gateway does not administer, so a request that only leaves the
// managed estate is visible to its author and to admins, and to no one else.
import type { Session } from "next-auth"

import { Role } from "@/generated/prisma/client"
import { hasRole } from "@/lib/auth/guard"

export interface TransferRequestForAccess {
  requestedByUserId: string
  targets: {
    project: {
      isPublic: boolean
      ownerUserId: string | null
      members: { userId: string }[]
    } | null
  }[]
}

export function canViewTransferRequest(transferRequest: TransferRequestForAccess, session: Session): boolean {
  if (hasRole(session, Role.ADMIN)) return true
  if (transferRequest.requestedByUserId === session.user.id) return true

  return transferRequest.targets.some(
    ({ project }) =>
      project !== null &&
      (project.isPublic ||
        project.ownerUserId === session.user.id ||
        project.members.some((member) => member.userId === session.user.id)),
  )
}
