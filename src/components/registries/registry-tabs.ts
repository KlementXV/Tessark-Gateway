import type { SectionTab } from "@/components/layout/section-tabs"

/**
 * The Registries sub-navigation.
 *
 * A constant rather than a function of the session: /registries as a whole is gated on ADMIN
 * by its layout, so every tab here is reachable by anyone who can see the row at all. The one
 * surface that is SUPERADMIN-only — transfer rules — is a section inside Policy that the page
 * hides, not a tab that would answer 403 to the person it was shown to.
 *
 * Four questions, in the order an operator asks them: what Harbors do we have, what do we
 * keep in step on a schedule, what has actually run, and what is allowed in the first place.
 * "Mirrors" and the mesh view are deliberately not both here — mirrors keep one image fresh
 * in one project, whereas the mesh is a property of a cluster and lives on its page.
 */
export const REGISTRY_TABS: SectionTab[] = [
  { href: "/registries", labelKey: "harborFleet" },
  { href: "/registries/mirrors", labelKey: "mirrors" },
  { href: "/registries/builds", labelKey: "builds" },
  { href: "/registries/activity", labelKey: "activity" },
  { href: "/registries/policy", labelKey: "policy" },
]
