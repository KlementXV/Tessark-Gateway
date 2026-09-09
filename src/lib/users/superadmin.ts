// The one invariant no path may break: an instance always keeps at least one SUPERADMIN who
// can actually sign in. Everything that can demote, disable or delete an account goes
// through here — the admin API, and the OIDC role mapping, which re-applies itself at every
// sign-in and would otherwise let one mistyped group name lock everyone out of user
// administration with no way back.
import { Role } from "@/generated/prisma/client"
import { prisma } from "@/lib/prisma"

/**
 * True when `userId` is the only enabled SUPERADMIN left, so removing their role or their
 * access would leave nobody able to administer users.
 */
export async function isLastActiveSuperadmin(userId: string): Promise<boolean> {
  const others = await prisma.user.count({
    where: { role: Role.SUPERADMIN, disabled: false, id: { not: userId } },
  })
  return others === 0
}
