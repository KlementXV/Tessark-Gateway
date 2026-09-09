import { auth } from "@/auth"
import { AppSidebarClient } from "@/components/layout/app-sidebar-client"
import { hasRole } from "@/lib/auth/guard"
import { Role } from "@/generated/prisma/client"
import { countPendingRequests } from "@/lib/requests/service"
import { getInstanceSettings } from "@/lib/settings/service"
import { getUserProfile } from "@/lib/users/profile"
import type { Sidebar } from "@/components/ui/sidebar"

export async function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const [session, branding] = await Promise.all([auth(), getInstanceSettings()])
  // Name, email and avatar come from the database, not the JWT: the token is minted at
  // login and would keep showing the old values until the next sign-in, right after the
  // user edits them in /settings.
  const profile = session?.user?.id ? await getUserProfile(session.user.id) : null
  const user = {
    name: profile?.name || profile?.username || session?.user?.name || "Admin",
    email: profile?.email ?? session?.user?.email ?? "",
    avatarUrl: profile?.avatarUrl ?? null,
  }
  const userRole = session?.user?.role ?? "USER"

  // Only reviewers get the badge, so only they pay for the count.
  const pendingRequests = hasRole(session, Role.ADMIN) ? await countPendingRequests() : 0

  return (
    <AppSidebarClient
      user={user}
      userRole={userRole}
      branding={branding}
      pendingRequests={pendingRequests}
      {...props}
    />
  )
}
