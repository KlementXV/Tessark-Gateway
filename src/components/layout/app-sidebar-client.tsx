"use client"

import { Boxes, Inbox, Server, Settings2 } from "lucide-react"
import { useTranslations } from "next-intl"

import { NavMain, type NavItem } from "@/components/layout/nav-main"
import { NavUser } from "@/components/layout/nav-user"
import { BrandHeader } from "@/components/layout/brand-header"
import { ThemeToggle } from "@/components/layout/theme-toggle"
import { Role } from "@/generated/prisma/client"
import type { InstanceBranding } from "@/lib/settings/service"
import { cn } from "@/lib/utils"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarRail,
} from "@/components/ui/sidebar"

export function AppSidebarClient({
  user,
  userRole,
  branding,
  pendingRequests,
  className,
  ...props
}: React.ComponentProps<typeof Sidebar> & {
  user: { name: string; email: string; avatarUrl: string | null }
  userRole: Role
  branding: InstanceBranding
  pendingRequests: number
}) {
  const t = useTranslations("nav")
  const isAdmin = userRole === Role.ADMIN || userRole === Role.SUPERADMIN

  // Four destinations at most: group headings above one or two entries each are pure noise,
  // so the main list carries no label and Settings is pinned to the bottom of the rail.
  const navMain: NavItem[] = [
    { title: t("projects"), url: "/projects", icon: Boxes },
  ]
  if (isAdmin) {
    navMain.push({ title: t("registries"), url: "/registries", icon: Server })
    navMain.push({
      title: t("reviewQueue"),
      url: "/requests",
      icon: Inbox,
      badge: pendingRequests,
      badgeLabel: pendingRequests
        ? t("pendingCount", { count: pendingRequests })
        : undefined,
    })
  }

  // One sidebar entry per section; sub-pages (My requests, Upstream sources, API tokens,
  // Users, Branding…) live in each section's tab row rather than being repeated here.
  const navSettings: NavItem[] = [
    { title: t("settings"), url: "/settings", icon: Settings2 },
  ]

  return (
    <Sidebar
      collapsible="icon"
      className={cn(
        "[&>[data-sidebar=sidebar]]:rounded-2xl [&>[data-sidebar=sidebar]]:border [&>[data-sidebar=sidebar]]:border-sidebar-border/80 [&>[data-sidebar=sidebar]]:shadow-[0_18px_50px_-32px_oklch(0_0_0/0.45)]",
        className,
      )}
      {...props}
    >
      <SidebarHeader className="border-b border-sidebar-border/70 px-3 py-2.5 group-data-[collapsible=icon]:px-2">
        <BrandHeader branding={branding} />
      </SidebarHeader>
      <SidebarContent className="gap-0 py-2">
        <NavMain items={navMain} />
        <NavMain items={navSettings} className="mt-auto" />
      </SidebarContent>
      <SidebarFooter className="gap-1.5 border-t border-sidebar-border/70 px-3 py-2.5 group-data-[collapsible=icon]:px-2">
        <ThemeToggle />
        <NavUser user={user} />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
