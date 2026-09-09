import type { Metadata } from "next"
import { Boxes, Download, HardDrive, Inbox, Trash2 } from "lucide-react"
import { getTranslations } from "next-intl/server"

import { PageHeader } from "@/components/layout/page-header"
import { SectionTabs } from "@/components/layout/section-tabs"
import { PendingRequestsList } from "@/components/requests/pending-requests-list"
import { REQUEST_TABS } from "@/components/requests/request-tabs"
import { MetricGrid } from "@/components/ui/metric-grid"
import { purgeHistoryInBackground } from "@/lib/history/retention"
import { listPendingRequests } from "@/lib/requests/service"

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("nav")
  return { title: t("reviewQueue") }
}

// Access is gated by the requests layout.
export default async function RequestsPage() {
  // Same opportunistic trim as the history tab: whoever reviews requests is the reader most
  // likely to be here, and the queue itself is never touched — only settled rows are.
  purgeHistoryInBackground()

  const [requests, t, tNav] = await Promise.all([
    listPendingRequests(),
    getTranslations("requests"),
    getTranslations("nav"),
  ])

  const projects = requests.filter((item) => item.kind === "PROJECT").length
  const pulls = requests.filter((item) => item.kind === "TRANSFER").length
  const quotas = requests.filter((item) => item.kind === "QUOTA").length
  const deletions = requests.filter((item) => item.kind === "PROJECT_DELETE").length

  return (
    <>
      <SectionTabs tabs={REQUEST_TABS} label={tNav("reviewQueue")} />

      <PageHeader
        title={t("queueTitle")}
        description={t("queueDescription")}
      >
        <MetricGrid
          metrics={[
            {
              icon: Inbox,
              label: t("metricAwaiting"),
              value: requests.length,
              tone: requests.length > 0 ? "warning" : "default",
            },
            { icon: Boxes, label: t("metricProjects"), value: projects },
            { icon: Download, label: t("metricTransfers"), value: pulls },
            { icon: HardDrive, label: t("metricQuotas"), value: quotas },
            {
              icon: Trash2,
              label: t("metricDeletions"),
              value: deletions,
              // The one metric worth colouring: a deletion waiting for review is the only thing
              // in this queue that destroys a project.
              tone: deletions > 0 ? "warning" : "default",
            },
          ]}
        />
      </PageHeader>

      <PendingRequestsList requests={requests} />
    </>
  )
}
