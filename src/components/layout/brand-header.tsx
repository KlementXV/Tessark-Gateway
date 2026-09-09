"use client"

import Link from "next/link"

import { BrandMark } from "@/components/layout/brand-mark"
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar"
import type { InstanceBranding } from "@/lib/settings/branding"

export function BrandHeader({ branding }: { branding: InstanceBranding }) {
  const { brandName, brandTagline, logoUrl } = branding
  const { setOpenMobile } = useSidebar()

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton
          size="lg"
          asChild
          tooltip={brandName}
          // px-1.5 + a 28px mark puts the logo's axis at 20px from the button edge, on the
          // same vertical line as the nav icons (px-3 + 16px). Collapsed, the button is
          // forced to 32px square by the base variant: centre the mark and drop the text
          // block entirely, otherwise its `gap` alone shifts the logo off-axis.
          className="h-14 gap-3 rounded-xl px-1.5 hover:bg-sidebar-accent/70 active:scale-[0.99] group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:gap-0"
        >
          <Link href="/projects" onClick={() => setOpenMobile(false)}>
            <BrandMark
              brandName={brandName}
              logoUrl={logoUrl}
              className="size-7 p-0.5 group-data-[collapsible=icon]:size-6"
            />
            <div className="grid min-w-0 flex-1 gap-0.5 text-left leading-none group-data-[collapsible=icon]:hidden">
              <span className="truncate text-sm font-semibold tracking-[-0.02em]">
                {brandName}
              </span>
              {brandTagline && (
                <span className="truncate text-[10px] font-medium tracking-[0.12em] text-sidebar-foreground/45 uppercase">
                  {brandTagline}
                </span>
              )}
            </div>
          </Link>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
