import type { SectionTab } from "@/components/layout/section-tabs"

// One surface, two views: a project and the request that created it are one surface — the
// request just hasn't become a project yet.
export const PROJECT_TABS: SectionTab[] = [
  { href: "/projects", labelKey: "projects" },
  { href: "/projects/requests", labelKey: "myRequests" },
]
