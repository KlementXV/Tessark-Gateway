import type { Metadata } from "next"
import { CircleCheck, Clock3, Network, Plus, Server } from "lucide-react"
import { getTranslations } from "next-intl/server"

import { ClusterFormDialog } from "@/components/clusters/cluster-form-dialog"
import { PageHeader } from "@/components/layout/page-header"
import { AddRegistryDialog } from "@/components/registries/add-registry-dialog"
import { RegistriesBoard } from "@/components/registries/registries-board"
import { Button } from "@/components/ui/button"
import { MetricGrid } from "@/components/ui/metric-grid"
import { isUsable } from "@/lib/registries/health"
import { listRegistryGroups } from "@/lib/registries/groups"

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("nav")
  return { title: t("registries") }
}

// Registries and clusters used to be two tabs; they are one list now, with each Harbor shown
// inside the cluster it belongs to.
export default async function RegistriesPage() {
  const [{ groups, unassigned, registries }, t] = await Promise.all([
    listRegistryGroups(),
    getTranslations("registries"),
  ])

  const healthy = registries.filter((r) => isUsable(r.health)).length
  const queued = registries.reduce((sum, r) => sum + r.pendingOperations, 0)

  return (
    <>
      <PageHeader
        title={t("fleetTitle")}
        description={t("fleetDescription", { count: registries.length, clusters: groups.length })}
        action={
          <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto [&_[data-slot=button]]:w-full sm:[&_[data-slot=button]]:w-auto">
            <ClusterFormDialog
              trigger={
                <Button variant="outline">
                  <Plus />
                  {t("newCluster")}
                </Button>
              }
            />
            <AddRegistryDialog />
          </div>
        }
      >
        <MetricGrid
          metrics={[
            { icon: Server, label: t("metricRegistries"), value: registries.length },
            {
              icon: CircleCheck,
              label: t("metricHealthy"),
              value: `${healthy}/${registries.length}`,
              tone:
                registries.length === 0 ? "default" : healthy === registries.length ? "success" : "warning",
            },
            { icon: Network, label: t("metricClusters"), value: groups.length },
            {
              icon: Clock3,
              label: t("metricQueued"),
              value: queued,
              tone: queued > 0 ? "warning" : "default",
            },
          ]}
        />
      </PageHeader>

      <RegistriesBoard groups={groups} unassigned={unassigned} />
    </>
  )
}
