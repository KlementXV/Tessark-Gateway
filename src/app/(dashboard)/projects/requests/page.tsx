import type { Metadata } from "next"
import { redirect } from "next/navigation"
import { getTranslations } from "next-intl/server"
import { CircleAlert, Clock3, Inbox, LoaderCircle } from "lucide-react"

import { PageHeader } from "@/components/layout/page-header"
import { SectionTabs } from "@/components/layout/section-tabs"
import { PROJECT_TABS } from "@/components/projects/project-tabs"
import { MetricGrid } from "@/components/ui/metric-grid"
import { RequestsReadOnlyList } from "@/components/requests/requests-read-only-list"
import { auth } from "@/auth"
import { listRequestsForUser } from "@/lib/requests/service"

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("nav")
  return { title: t("myRequests") }
}

// Everything this user asked for — new projects and image pulls alike — whatever state it is
// in. Reviewing happens in Admin › Requests, so this tab only reports.
export default async function MyRequestsPage() {
  const session = await auth()
  if (!session?.user) redirect("/login")

  const [requests, t, tNav] = await Promise.all([
    listRequestsForUser(session.user.id),
    getTranslations("projects.myRequests"),
    getTranslations("nav"),
  ])
  const pending = requests.filter((item) => item.status === "PENDING").length
  const running = requests.filter((item) => item.status === "RUNNING").length
  const issues = requests.filter(
    (item) => item.status === "FAILED" || item.status === "REJECTED"
  ).length

  return (
    <>
      <SectionTabs tabs={PROJECT_TABS} label={tNav("projects")} />

      <PageHeader
        title={t("title")}
        description={t("description")}
      >
        <MetricGrid
          metrics={[
            { icon: Inbox, label: t("metricRequests"), value: requests.length },
            {
              icon: Clock3,
              label: t("metricPending"),
              value: pending,
              tone: pending > 0 ? "warning" : "default",
            },
            { icon: LoaderCircle, label: t("metricRunning"), value: running },
            {
              icon: CircleAlert,
              label: t("metricIssues"),
              value: issues,
              tone: issues > 0 ? "destructive" : "default",
            },
          ]}
        />
      </PageHeader>

      <RequestsReadOnlyList
        requests={requests}
        emptyTitle={t("emptyTitle")}
        emptyHint={t("emptyHint")}
      />
    </>
  )
}
