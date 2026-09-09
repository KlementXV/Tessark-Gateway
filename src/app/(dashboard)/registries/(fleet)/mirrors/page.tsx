import type { Metadata } from "next"
import { redirect } from "next/navigation"
import { getTranslations } from "next-intl/server"

import { auth } from "@/auth"
import { requireRole } from "@/lib/auth/guard"
import { Role } from "@/generated/prisma/client"
import { PageHeader } from "@/components/layout/page-header"
import { MirrorFormDialog } from "@/components/mirrors/mirror-form-dialog"
import { MirrorsBoard } from "@/components/mirrors/mirrors-board"
import { listMirrorsWithRuns } from "@/lib/mirrors/view"
import { listTransferDestinations, listTransferSourceRegistries } from "@/lib/projects/service"
import { listPickableSources } from "@/lib/sources/service"

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("mirrors")
  return { title: t("title") }
}

// ADMIN, matching /api/mirrors. Reading the page asks every transport for its run history —
// a Harbor call per policy, a Kubernetes call per CronJob — so it is dynamic by construction.
export default async function MirrorsPage() {
  const session = await auth()
  if (!session?.user) redirect("/login")
  requireRole(session, Role.ADMIN)

  const [mirrors, sources, sourceRegistries, destinations, t] = await Promise.all([
    listMirrorsWithRuns(),
    listPickableSources(),
    listTransferSourceRegistries(session),
    listTransferDestinations(session),
    getTranslations("mirrors"),
  ])

  return (
    <>
      <PageHeader
        title={t("title")}
        description={t("description")}
        action={
          <MirrorFormDialog
            sources={sources}
            sourceRegistries={sourceRegistries}
            destinations={destinations}
          />
        }
      />

      <MirrorsBoard mirrors={mirrors} />
    </>
  )
}
