import type { Metadata } from "next"
import { redirect } from "next/navigation"
import { getTranslations } from "next-intl/server"

import { auth } from "@/auth"
import { requireRole } from "@/lib/auth/guard"
import { Role } from "@/generated/prisma/client"
import { PageHeader } from "@/components/layout/page-header"
import { ActivityBoard } from "@/components/activity/activity-board"
import { OrphanScanner } from "@/components/activity/orphan-scanner"
import { listActivity } from "@/lib/activity/view"

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("activity")
  return { title: t("title") }
}

// ADMIN, matching /api/jobs. Every render asks Kubernetes and every Harbor what they have
// run, so this is dynamic by construction — caching it would be caching the one thing that
// must be live.
export const dynamic = "force-dynamic"

export default async function ActivityPage() {
  const session = await auth()
  if (!session?.user) redirect("/login")
  requireRole(session, Role.ADMIN)

  const [view, t] = await Promise.all([listActivity(), getTranslations("activity")])

  return (
    <>
      <PageHeader title={t("title")} description={t("description")} />
      <ActivityBoard view={view} />
      <OrphanScanner />
    </>
  )
}
