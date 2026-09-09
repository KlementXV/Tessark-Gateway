import { getTranslations } from "next-intl/server"

import { auth } from "@/auth"
import { AppSidebar } from "@/components/layout/app-sidebar"
import { BreadcrumbProvider } from "@/components/layout/breadcrumb-context"
import { SiteHeader } from "@/components/layout/site-header"
import { countUnreadNotifications } from "@/lib/notifications/service"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"

export default async function DashboardLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  const [session, t] = await Promise.all([auth(), getTranslations("common")])
  const userRole = session?.user?.role ?? "USER"
  // Server-rendered so the badge is correct on first paint; the list behind it is only
  // fetched when the bell is actually opened.
  const unreadNotifications = session?.user?.id ? await countUnreadNotifications(session.user.id) : 0

  return (
    <SidebarProvider
      style={
        {
          "--sidebar-width": "calc(var(--spacing) * 68)",
          "--header-height": "calc(var(--spacing) * 12)",
        } as React.CSSProperties
      }
    >
      <a href="#main-content" className="skip-link">
        {t("skipToContent")}
      </a>
      <AppSidebar variant="inset" />
      <SidebarInset id="main-content" tabIndex={-1}>
        <BreadcrumbProvider>
        <SiteHeader userRole={userRole} unreadNotifications={unreadNotifications} />
        <div className="flex flex-1 flex-col">
          <div className="@container/main flex flex-1 flex-col">
            <div className="mx-auto flex w-full max-w-[90rem] flex-col gap-4 py-4 md:gap-6 md:py-6">
              {children}
            </div>
          </div>
        </div>
        </BreadcrumbProvider>
      </SidebarInset>
    </SidebarProvider>
  )
}
