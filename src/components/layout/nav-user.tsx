"use client"

import { ChevronsUpDown, LogOut, Settings2 } from "lucide-react"
import Link from "next/link"
import { useTranslations } from "next-intl"

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { LocaleMenuSub } from "@/components/layout/locale-switcher"
import { signOutTo } from "@/lib/auth/sign-out"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar"

export function NavUser({
  user,
}: {
  user: { name: string; email: string; avatarUrl: string | null }
}) {
  const t = useTranslations("nav")
  const { isMobile, setOpenMobile } = useSidebar()
  const initials = user.name
    .split(" ")
    .map((n) => n[0])
    .join("")
    .slice(0, 2)
    .toUpperCase()

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              tooltip={user.name}
              aria-label={user.name}
              className="h-14 gap-3 rounded-xl px-2.5 transition-[background-color,color,transform] duration-200 hover:bg-sidebar-accent active:scale-[0.99] data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:gap-0"
            >
              {/* Collapsed the button is forced to 32px square: the avatar must not be
                  squeezed by the name block, which is dropped entirely. */}
              <Avatar className="size-8 shrink-0 rounded-lg">
                {user.avatarUrl && (
                  <AvatarImage src={user.avatarUrl} alt="" className="object-cover" />
                )}
                <AvatarFallback className="rounded-lg bg-sidebar-primary text-[11px] font-semibold tracking-wide text-sidebar-primary-foreground">
                  {initials}
                </AvatarFallback>
              </Avatar>
              <div className="grid min-w-0 flex-1 gap-0.5 text-left leading-tight group-data-[collapsible=icon]:hidden">
                <span className="truncate text-[13px] font-semibold">{user.name}</span>
                <span className="truncate text-[11px] text-sidebar-foreground/60">
                  {user.email}
                </span>
              </div>
              <ChevronsUpDown
                aria-hidden="true"
                className="ml-auto size-3.5 text-sidebar-foreground/55 group-data-[collapsible=icon]:hidden"
              />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-lg"
            side={isMobile ? "bottom" : "right"}
            align="end"
            sideOffset={4}
          >
            <DropdownMenuLabel className="p-0 font-normal">
              <div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">
                <Avatar className="h-8 w-8 rounded-lg">
                  {user.avatarUrl && (
                    <AvatarImage src={user.avatarUrl} alt="" className="object-cover" />
                  )}
                  <AvatarFallback className="rounded-lg bg-primary text-xs font-semibold text-primary-foreground">
                    {initials}
                  </AvatarFallback>
                </Avatar>
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-medium">{user.name}</span>
                  <span className="truncate text-xs">{user.email}</span>
                </div>
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem asChild>
                <Link href="/settings" onClick={() => setOpenMobile(false)}>
                  <Settings2 />
                  {t("settings")}
                </Link>
              </DropdownMenuItem>
              <LocaleMenuSub />
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onClick={() => void signOutTo()}
            >
              <LogOut />
              {t("logOut")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
