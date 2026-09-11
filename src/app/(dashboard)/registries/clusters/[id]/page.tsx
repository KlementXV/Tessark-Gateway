import type { CSSProperties } from "react"
import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { BookUser, Boxes, IdCard, Network, Pencil, Server } from "lucide-react"
import { getTranslations } from "next-intl/server"

import { auth } from "@/auth"
import { Role } from "@/generated/prisma/client"
import { hasRole } from "@/lib/auth/guard"
import { ClusterDirectoryConfigDialog } from "@/components/clusters/cluster-directory-config-dialog"
import { PageBreadcrumb } from "@/components/layout/breadcrumb-context"
import { PageHeader, SubHeader } from "@/components/layout/page-header"
import { ClusterFormDialog } from "@/components/clusters/cluster-form-dialog"
import { ClusterIdentitiesDialog } from "@/components/clusters/cluster-identities-dialog"
import { ClusterDirectoryPanel } from "@/components/clusters/cluster-directory-panel"
import { ClusterMeshPanel } from "@/components/clusters/cluster-mesh-panel"
import { RegistryCard } from "@/components/registries/registry-card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { MetricGrid } from "@/components/ui/metric-grid"
import { getClusterDetail } from "@/lib/clusters/detail"
import { getClusterDirectoryView } from "@/lib/clusters/directory-view"
import { getClusterReplication } from "@/lib/clusters/replication-view"

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params
  const [detail, tNav] = await Promise.all([getClusterDetail(id), getTranslations("nav")])
  return { title: detail?.cluster.name ?? tNav("registries") }
}

/**
 * One cluster: who is in it, and whether its Harbors are in step.
 *
 * Clusters used to exist only as sections of the fleet list, with their mesh in a tab of its
 * own — so the two halves of "is this cluster healthy?" were never on the same screen, and
 * everything a cluster *is* (its replication mode, its identity directory, its members) had
 * nowhere to be shown at full size. This is that page.
 *
 * ADMIN by the section's layout, like every /registries route.
 */
export default async function ClusterDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const [detail, t, tNav] = await Promise.all([
    getClusterDetail(id),
    getTranslations("clusters"),
    getTranslations("nav"),
  ])
  if (!detail) notFound()

  const { cluster, members, projectCount, unmappedMembers } = detail
  // Read after the cluster exists, not alongside: an unreachable member costs a Harbor
  // timeout, and paying it to render a 404 would be the slowest way to say "no such cluster".
  const [mesh, directory, session] = await Promise.all([
    getClusterReplication(id),
    getClusterDirectoryView(id),
    auth(),
  ])

  return (
    <>
      <PageBreadcrumb
        crumbs={[{ label: tNav("registries"), href: "/registries" }, { label: cluster.name }]}
      />

      <PageHeader
        size="lg"
        back={{ href: "/registries", label: tNav("registries") }}
        title={cluster.name}
        badges={
          unmappedMembers > 0 ? (
            <Badge className="bg-warning/15 text-warning">
              {t("identities.unmapped", { count: unmappedMembers })}
            </Badge>
          ) : null
        }
        description={cluster.description}
        meta={cluster.registryUrl ? <span className="break-all font-mono">{cluster.registryUrl}</span> : undefined}
        action={
          <div className="flex w-full shrink-0 gap-2 sm:w-auto [&_[data-slot=button]]:flex-1 sm:[&_[data-slot=button]]:flex-none">
            {cluster.identityMode === "MAPPED" && (
              <ClusterIdentitiesDialog
                clusterId={cluster.id}
                clusterName={cluster.name}
                trigger={
                  <Button variant="outline">
                    <IdCard />
                    {t("identities.title")}
                  </Button>
                }
              />
            )}
            <ClusterFormDialog
              cluster={{
                id: cluster.id,
                name: cluster.name,
                description: cluster.description ?? "",
                registryUrl: cluster.registryUrl ?? "",
                replicationMode: cluster.replicationMode as "event_based" | "scheduled" | "none",
                replicationCron: cluster.replicationCron ?? "",
                identityMode: cluster.identityMode,
              }}
              trigger={
                <Button variant="outline">
                  <Pencil />
                  {t("editCluster")}
                </Button>
              }
            />
          </div>
        }
      >
        <MetricGrid
          metrics={[
            { icon: Server, label: t("detail.metricMembers"), value: members.length },
            { icon: Boxes, label: t("detail.metricProjects"), value: projectCount },
            {
              icon: Network,
              label: t("detail.metricLinks"),
              value: mesh ? `${mesh.links.length}/${mesh.expectedLinks}` : "—",
              tone: mesh && mesh.links.length < mesh.expectedLinks ? "warning" : "default",
            },
            {
              icon: IdCard,
              label: t("detail.metricIdentity"),
              value: cluster.identityMode === "MAPPED" ? t("identityMapped") : t("identityGateway"),
              tone: unmappedMembers > 0 ? "warning" : "default",
            },
          ]}
        />
      </PageHeader>

      <section className="animate-enter flex flex-col gap-3 px-4 lg:px-6" style={{ "--enter-delay": "60ms" } as CSSProperties}>
        <SubHeader title={t("detail.membersTitle")} description={t("detail.membersDescription")} />
        {members.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed px-6 py-12 text-center">
            <div className="flex size-11 items-center justify-center rounded-md bg-muted">
              <Server className="size-5 text-muted-foreground" />
            </div>
            <div>
              <p className="text-sm font-medium">{t("detail.noMembersTitle")}</p>
              <p className="mt-1 text-sm text-muted-foreground">{t("detail.noMembersHint")}</p>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 @xl/main:grid-cols-2 @5xl/main:grid-cols-3">
            {members.map((member) => (
              <RegistryCard
                key={member.id}
                registry={member}
                returnTo={`/registries/clusters/${cluster.id}`}
              />
            ))}
          </div>
        )}
      </section>

      {mesh && <ClusterMeshPanel cluster={mesh} />}

      {directory && (
        <ClusterDirectoryPanel
          view={directory}
          action={
            // Writing a directory configuration decides who can sign in to every Harbor of the
            // cluster: SUPERADMIN, on top of the ADMIN the section already requires.
            hasRole(session, Role.SUPERADMIN) ? (
              <ClusterDirectoryConfigDialog
                clusterId={cluster.id}
                clusterName={cluster.name}
                trigger={
                  <Button variant="outline" size="sm">
                    <BookUser />
                    {t("directoryConfig.trigger")}
                  </Button>
                }
              />
            ) : undefined
          }
        />
      )}
    </>
  )
}
