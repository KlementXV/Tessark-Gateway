"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { ChevronRight } from "lucide-react"
import { useTranslations } from "next-intl"
import { Separator } from "@/components/ui/separator"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { type Crumb, useBreadcrumbOverride } from "@/components/layout/breadcrumb-context"
import { CommandPalette } from "@/components/layout/command-palette"
import { NotificationBell } from "@/components/layout/notification-bell"
import type { Role } from "@/generated/prisma/client"

type NavT = ReturnType<typeof useTranslations<"nav">>

function breadcrumbs(pathname: string, t: NavT): Crumb[] {
  if (pathname === "/projects/requests") {
    return [{ label: t("projects"), href: "/projects" }, { label: t("myRequests") }]
  }
  if (pathname.startsWith("/projects/")) {
    return [{ label: t("projects"), href: "/projects" }, { label: t("projectDetails") }]
  }
  if (pathname === "/projects") return [{ label: t("projects") }]

  // The fleet tabs are leaves of Registries, not registries themselves: without naming them
  // here they all fell through to the entity branch below and were labelled "Registry
  // details", which is the one thing they are not.
  const registriesLeaf: Record<string, string> = {
    "/registries/mirrors": t("mirrors"),
    "/registries/builds": t("builds"),
    "/registries/activity": t("activity"),
    "/registries/policy": t("policy"),
  }
  if (registriesLeaf[pathname]) {
    return [{ label: t("registries"), href: "/registries" }, { label: registriesLeaf[pathname] }]
  }
  // Entity pages: a cluster, a registry, or a repository inside one. Each replaces this crumb
  // with the real name through <PageBreadcrumb> once its data is in.
  if (pathname.startsWith("/registries/clusters/")) {
    return [{ label: t("registries"), href: "/registries" }, { label: t("clusterDetails") }]
  }
  if (pathname.startsWith("/registries/")) {
    const depth = pathname.split("/").filter(Boolean).length
    return [
      { label: t("registries"), href: "/registries" },
      { label: depth > 2 ? t("repository") : t("registryDetails") },
    ]
  }
  if (pathname === "/registries") return [{ label: t("registries") }]

  if (pathname === "/requests/history") {
    return [{ label: t("reviewQueue"), href: "/requests" }, { label: t("history") }]
  }
  if (pathname === "/requests") return [{ label: t("reviewQueue") }]

  const settingsLeaf: Record<string, string> = {
    "/settings/tokens": t("apiTokens"),
    "/settings/users": t("users"),
    "/settings/branding": t("branding"),
    "/settings/login": t("loginPage"),
    "/settings/history": t("history"),
  }
  if (settingsLeaf[pathname]) {
    return [{ label: t("settings"), href: "/settings" }, { label: settingsLeaf[pathname] }]
  }
  if (pathname === "/settings") return [{ label: t("settings") }]

  return [{ label: t("dashboard") }]
}

export function SiteHeader({ userRole, unreadNotifications }: { userRole: Role; unreadNotifications: number }) {
  const t = useTranslations("nav")
  const pathname = usePathname()
  // Entity pages replace the URL-derived tail ("Project details") with the real name once
  // their data is in; until then the generic crumbs keep the header stable.
  const override = useBreadcrumbOverride()
  const crumbs = override ?? breadcrumbs(pathname, t)

  return (
    <header className="sticky top-0 z-20 flex h-(--header-height) shrink-0 items-center gap-2 border-b bg-background/92 backdrop-blur-md transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-(--header-height) md:group-has-data-[variant=inset]/sidebar-wrapper:rounded-t-xl">
      <div className="flex w-full items-center gap-1 px-4 lg:gap-2 lg:px-6">
        <SidebarTrigger className="-ml-1" />
        <Separator orientation="vertical" className="mx-2 data-[orientation=vertical]:h-4" />
        <nav aria-label={t("breadcrumb")} className="min-w-0 flex-1">
          <ol className="flex min-w-0 items-center gap-1.5 text-sm">
            {crumbs.map((crumb, index) => {
              const current = index === crumbs.length - 1
              return (
                <li key={`${crumb.label}-${index}`} className="flex min-w-0 items-center gap-1.5">
                  {index > 0 && (
                    <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/55" aria-hidden="true" />
                  )}
                  {crumb.href && !current ? (
                    <Link
                      href={crumb.href}
                      className="truncate rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {crumb.label}
                    </Link>
                  ) : (
                    <span aria-current={current ? "page" : undefined} className="truncate font-medium">
                      {crumb.label}
                    </span>
                  )}
                </li>
              )
            })}
          </ol>
        </nav>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <CommandPalette userRole={userRole} />
          <NotificationBell initialUnread={unreadNotifications} />
        </div>
      </div>
    </header>
  )
}
