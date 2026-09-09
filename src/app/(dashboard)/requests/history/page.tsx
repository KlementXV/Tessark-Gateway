import type { Metadata } from "next"
import { CircleCheck, CircleX, History } from "lucide-react"
import { getTranslations } from "next-intl/server"

import { PageHeader } from "@/components/layout/page-header"
import { SectionTabs } from "@/components/layout/section-tabs"
import { REQUEST_TABS } from "@/components/requests/request-tabs"
import { RequestsReadOnlyList } from "@/components/requests/requests-read-only-list"
import { MetricGrid } from "@/components/ui/metric-grid"
import { purgeHistoryInBackground } from "@/lib/history/retention"
import { listReviewedRequests } from "@/lib/requests/service"

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("nav")
  return { title: t("requestHistory") }
}

// Access is gated by the requests layout.
export default async function RequestsHistoryPage() {
  // No scheduler in this app, so the retention window is applied on the way in — here
  // above all, the one page whose whole subject is the history being trimmed.
  purgeHistoryInBackground()

  const [requests, t, tNav] = await Promise.all([
    listReviewedRequests(),
    getTranslations("requests"),
    getTranslations("nav"),
  ])

  const approved = requests.filter(
    (item) => item.status === "ACTIVE" || item.status === "APPROVED" || item.status === "SUCCEEDED"
  ).length
  const rejected = requests.filter((item) => item.status === "REJECTED").length

  return (
    <>
      <SectionTabs tabs={REQUEST_TABS} label={tNav("reviewQueue")} />

      <PageHeader
        title={t("historyTitle")}
        description={t("historyDescription")}
      >
        <MetricGrid
          metrics={[
            { icon: History, label: t("metricReviewed"), value: requests.length },
            { icon: CircleCheck, label: t("metricApproved"), value: approved, tone: approved > 0 ? "success" : "default" },
            { icon: CircleX, label: t("metricRejected"), value: rejected },
          ]}
        />
      </PageHeader>

      <RequestsReadOnlyList
        requests={requests}
        emptyTitle={t("historyEmptyTitle")}
        emptyHint={t("historyEmptyHint")}
      />
    </>
  )
}
