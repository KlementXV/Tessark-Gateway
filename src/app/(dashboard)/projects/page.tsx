import type { Metadata } from "next"
import { redirect } from "next/navigation"
import { getTranslations } from "next-intl/server"
import { Boxes, Globe2, Network, TriangleAlert } from "lucide-react"

import { PageHeader } from "@/components/layout/page-header"
import { ProjectsList } from "@/components/projects/projects-list"
import { PROJECT_TABS } from "@/components/projects/project-tabs"
import { SectionTabs } from "@/components/layout/section-tabs"
import { MetricGrid } from "@/components/ui/metric-grid"
import { RequestProjectDialog } from "@/components/projects/request-project-dialog"
import { RequestTransferDialog } from "@/components/transfers/request-transfer-dialog"
import { auth } from "@/auth"
import { hasRole } from "@/lib/auth/guard"
import { getConfig } from "@/lib/config"
import { getEnterpriseCa } from "@/lib/settings/enterprise-ca"
import { Role } from "@/generated/prisma/client"
import {
  listProjectsForSession,
  listProjectTargets,
  listTransferDestinations,
  listTransferSourceRegistries,
} from "@/lib/projects/service"
import { listPickableSources } from "@/lib/sources/service"

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("nav")
  return { title: t("projects") }
}

export default async function ProjectsPage() {
  const session = await auth()
  if (!session?.user) redirect("/login")
  const [t, tNav, tTransfers] = await Promise.all([
    getTranslations("projects"),
    getTranslations("nav"),
    getTranslations("transfers"),
  ])

  const [projects, clusters, sources, sourceRegistries, destinations, enterpriseCa] =
    await Promise.all([
      listProjectsForSession(session),
      listProjectTargets(),
      listPickableSources(),
      listTransferSourceRegistries(session),
      listTransferDestinations(session),
      getEnterpriseCa(),
    ])
  const hasEnterpriseCa = Boolean(enterpriseCa.pem)
  const enterpriseCaJobDefault = enterpriseCa.jobDefault
  const publicCount = projects.filter((project) => project.isPublic).length
  const clusterCount = new Set(projects.map((project) => project.cluster.name)).size
  const syncIssues = projects.filter((project) => {
    const targetCount = project.cluster._count.registries
    const syncedCount = project.placements.filter((placement) => placement.status === "ACTIVE").length
    return syncedCount < targetCount
  }).length

  return (
    <>
      <SectionTabs tabs={PROJECT_TABS} label={tNav("projects")} />

      <PageHeader
        title={t("catalogTitle")}
        description={t("catalogDescription", { count: projects.length, clusters: clusterCount })}
        action={
          <div className="grid w-full grid-cols-1 gap-2 min-[440px]:grid-cols-2 sm:flex sm:w-auto [&_[data-slot=button]]:w-full sm:[&_[data-slot=button]]:w-auto">
            {/* A transfer spans destinations, so it belongs next to the catalog rather than
                inside any one project — the detail page reuses the same dialog, pre-ticked. */}
            <RequestTransferDialog
              sources={sources}
              sourceRegistries={sourceRegistries}
              destinations={destinations}
              canTransferDirectly={hasRole(session, Role.ADMIN)}
              hasEnterpriseCa={hasEnterpriseCa}
              enterpriseCaJobDefault={enterpriseCaJobDefault}
              disabledReason={getConfig().k8sEnabled ? undefined : tTransfers("disabledReason")}
            />
            <RequestProjectDialog clusters={clusters} canCreateDirectly={hasRole(session, Role.ADMIN)} />
          </div>
        }
      >
        <MetricGrid
          metrics={[
            { icon: Boxes, label: t("metricProjects"), value: projects.length },
            { icon: Globe2, label: t("metricPublic"), value: publicCount },
            { icon: Network, label: t("metricClusters"), value: clusterCount },
            {
              icon: TriangleAlert,
              label: t("metricSyncIssues"),
              value: syncIssues,
              tone: syncIssues > 0 ? "warning" : "default",
            },
          ]}
        />
      </PageHeader>

      <ProjectsList projects={projects} />
    </>
  )
}
