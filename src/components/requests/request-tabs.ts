import type { SectionTab } from "@/components/layout/section-tabs"

// The queue and what it turned into belong together, so they share /requests instead of
// taking two sidebar entries.
export const REQUEST_TABS: SectionTab[] = [
  { href: "/requests", labelKey: "pending" },
  { href: "/requests/history", labelKey: "history" },
]
