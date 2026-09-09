"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import type { LucideIcon } from "lucide-react"

import { cn } from "@/lib/utils"
import { LinkPending } from "@/components/layout/link-pending"
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar"

export type NavItem = {
  title: string
  url: string
  icon?: LucideIcon
  /** Only highlight on an exact path match (for parents of other nav entries). */
  exact?: boolean
  /** Count of items needing attention. Zero or undefined renders nothing. */
  badge?: number
  /** Spoken form of `badge`, e.g. "3 pending" — the bare number alone says nothing. */
  badgeLabel?: string
}

export function NavMain({
  items,
  label,
  className,
}: {
  items: NavItem[]
  label?: string
  className?: string
}) {
  const pathname = usePathname()
  // On mobile the sidebar is a sheet overlaying the page: without this it stays open on top
  // of the destination the user just picked.
  const { setOpenMobile } = useSidebar()

  return (
    <SidebarGroup
      className={cn("px-3 py-2 group-data-[collapsible=icon]:px-2", className)}
    >
      {label && (
        <SidebarGroupLabel className="h-7 px-3 text-[10px] font-semibold tracking-[0.12em] text-sidebar-foreground/55 uppercase">
          {label}
        </SidebarGroupLabel>
      )}
      <SidebarMenu className="gap-1.5 group-data-[collapsible=icon]:items-center">
        {items.map((item) => {
          // Segment-aware: "/registries" must not light up for "/registries-archive", and
          // "/settings" must stay lit on "/settings/users".
          const isActive =
            item.exact || item.url === "/"
              ? pathname === item.url
              : pathname === item.url || pathname.startsWith(`${item.url}/`)
          const hasBadge = Boolean(item.badge)

          return (
            <SidebarMenuItem key={item.title}>
              <SidebarMenuButton
                asChild
                isActive={isActive}
                tooltip={
                  item.badgeLabel && hasBadge
                    ? `${item.title} — ${item.badgeLabel}`
                    : item.title
                }
                className="h-10 gap-3 rounded-lg px-3 text-[13px] font-medium text-sidebar-foreground/70 transition-[background-color,color,transform] duration-200 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground active:scale-[0.985] data-[active=true]:bg-sidebar-primary data-[active=true]:font-semibold data-[active=true]:text-sidebar-primary-foreground group-data-[collapsible=icon]:rounded-lg"
              >
                <Link
                  href={item.url}
                  aria-current={isActive ? "page" : undefined}
                  onClick={() => setOpenMobile(false)}
                >
                  {item.icon && <item.icon />}
                  <span>{item.title}</span>
                  {/* The count lives in a sibling node for layout reasons; keyboard users
                      tabbing through links would otherwise never hear it. */}
                  {hasBadge && item.badgeLabel && (
                    <span className="sr-only">{item.badgeLabel}</span>
                  )}
                  <LinkPending
                    className={cn(
                      "ml-auto group-data-[collapsible=icon]:hidden",
                      // Keep clear of the badge sitting at the same right edge.
                      hasBadge && "mr-7",
                    )}
                  />
                </Link>
              </SidebarMenuButton>
              {hasBadge && (
                <>
                  <SidebarMenuBadge
                    aria-hidden="true"
                    className="top-2.5! right-2 rounded-md bg-warning/15 text-warning peer-data-[active=true]/menu-button:bg-sidebar-primary-foreground/15 peer-data-[active=true]/menu-button:text-sidebar-primary-foreground"
                  >
                    {item.badge}
                  </SidebarMenuBadge>
                  {/* The count has nowhere to go once the rail is collapsed to icons, so it
                      degrades to a dot on the corner of the icon. */}
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute top-0.5 right-0.5 hidden size-2 rounded-full bg-warning ring-2 ring-sidebar group-data-[collapsible=icon]:block"
                  />
                </>
              )}
            </SidebarMenuItem>
          )
        })}
      </SidebarMenu>
    </SidebarGroup>
  )
}
