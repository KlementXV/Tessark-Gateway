import type { SectionTab } from "@/components/layout/section-tabs"
import { Role } from "@/generated/prisma/client"

const ACCOUNT_TABS: SectionTab[] = [
  { href: "/settings", labelKey: "profile" },
  { href: "/settings/tokens", labelKey: "apiTokens" },
]

const ADMIN_TABS: SectionTab[] = [
  { href: "/settings/users", labelKey: "users" },
  { href: "/settings/branding", labelKey: "branding" },
  { href: "/settings/history", labelKey: "history" },
]

export function settingsTabsFor(role: Role): SectionTab[] {
  return role === Role.SUPERADMIN ? [...ACCOUNT_TABS, ...ADMIN_TABS] : ACCOUNT_TABS
}
