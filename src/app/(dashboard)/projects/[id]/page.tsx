import type { Metadata } from "next"
import { notFound, redirect } from "next/navigation"
import { getTranslations } from "next-intl/server"
import {
  Bot,
  CircleAlert,
  Clock3,
  Download,
  Gauge,
  Globe2,
  LockKeyhole,
  Package,
  RadioTower,
  Server,
  ShieldCheck,
  Users,
} from "lucide-react"

import { PageBreadcrumb } from "@/components/layout/breadcrumb-context"
import { MetaDot, PageHeader } from "@/components/layout/page-header"
import { Badge } from "@/components/ui/badge"
import { MetricGrid } from "@/components/ui/metric-grid"
import { TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { UrlTabs } from "@/components/ui/url-tabs"
import { ProjectMembersTab } from "@/components/projects/project-members-tab"
import { ProjectRobotsTab } from "@/components/projects/project-robots-tab"
import { ProjectRetentionTab } from "@/components/projects/project-retention-tab"
import { ProjectQuotaTab } from "@/components/projects/project-quota-tab"
import { ProjectSecurityTab } from "@/components/projects/project-security-tab"
import { DeleteProjectButton } from "@/components/projects/delete-project-button"
import { RequestProjectDeleteDialog } from "@/components/projects/request-project-delete-dialog"
import { MoveProjectDialog } from "@/components/projects/move-project-dialog"
import { ProjectTransfersTab } from "@/components/projects/project-transfers-tab"
import { ProjectHarborsTab, type HarborPlacement } from "@/components/projects/project-harbors-tab"
import { ProjectImagesTab } from "@/components/projects/project-images-tab"
import { auth } from "@/auth"
import { AuthError, hasRole } from "@/lib/auth/guard"
import { getConfig } from "@/lib/config"
import { getEnterpriseCa } from "@/lib/settings/enterprise-ca"
import { Role } from "@/generated/prisma/client"
import { prisma } from "@/lib/prisma"
import { loadProjectForAccess } from "@/lib/projects/access"
import { listTransferDestinations, listTransferSourceRegistries } from "@/lib/projects/service"
import { listPickableSources } from "@/lib/sources/service"

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const [{ id }, session] = await Promise.all([params, auth()])
  // Same access check as the page: a name must not leak into the tab title of someone who
  // is about to be told the project does not exist.
  try {
    const { project } = await loadProjectForAccess(id, session)
    return { title: project.name }
  } catch {
    const t = await getTranslations("nav")
    return { title: t("projectDetails") }
  }
}

export default async function ProjectDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ from?: string }>
}) {
  const [{ id }, query] = await Promise.all([params, searchParams])
  const returnTo =
    typeof query.from === "string" &&
    (query.from === "/projects" || query.from.startsWith("/projects?"))
      ? query.from
      : "/projects"
  const session = await auth()
  if (!session?.user) redirect("/login")

  let project, isManager
  try {
    ;({ project, isManager } = await loadProjectForAccess(id, session))
  } catch (err) {
    if (err instanceof AuthError && err.status === 404) notFound()
    redirect(returnTo)
  }

  // What the Transfers tab needs to offer a request: which sources are available (approved
  // upstreams, plus the Harbors an admin may take an image out of), and where this user may
  // send it (this project is only the default, not the only option).
  const [sources, destinations, sourceRegistries, enterpriseCa, memberUsers, memberIdentities, t, tNav] =
    await Promise.all([
    listPickableSources(),
    listTransferDestinations(session),
    listTransferSourceRegistries(session),
    getEnterpriseCa(),
    // Resolved here rather than from the client-side directory: the picker's directory call is
    // capped and searchable (an LDAP-backed instance can hold thousands of accounts), so it is
    // no longer a complete list to look member names up in.
    prisma.user.findMany({
      where: { id: { in: project.members.map((member) => member.userId) } },
      select: { id: true, username: true, name: true },
    }),
    // What each member is called on this cluster's Harbors, when the cluster keeps a directory
    // of its own. Shown next to the Gateway name: a membership nobody has mapped is a grant
    // that exists here and nowhere else.
    prisma.userClusterIdentity.findMany({
      where: {
        clusterId: project.clusterId,
        userId: { in: project.members.map((member) => member.userId) },
      },
      select: { userId: true, harborUsername: true },
    }),
    getTranslations("projects"),
    getTranslations("nav"),
  ])
  const hasEnterpriseCa = Boolean(enterpriseCa.pem)
  const enterpriseCaJobDefault = enterpriseCa.jobDefault

  // Who may remove what the project holds. Wider than `isManager` and narrower than the read
  // access this page already granted: it is the footing Harbor demands to push — a DEVELOPER
  // puts these images here — while a GUEST, and a stranger looking at a public project, only
  // ever look. Mirrors the check in DELETE /api/projects/[id]/images, which is the one that
  // decides.
  // Whether this project already has a deletion waiting for review, and whether the reader is
  // one of its people. Both only decide what the header offers; the endpoint decides what is
  // allowed.
  const isMember =
    project.ownerUserId === session?.user?.id ||
    project.members.some((member) => member.userId === session?.user?.id)
  const hasPendingDeleteRequest =
    (await prisma.projectDeleteRequest.count({
      where: { projectId: project.id, status: "PENDING" },
    })) > 0

  const canWriteImages =
    hasRole(session, Role.ADMIN) ||
    project.ownerUserId === session?.user?.id ||
    project.members.some(
      (member) => member.userId === session?.user?.id && member.role !== "GUEST",
    )

  // Where this project could go instead. Admin-only, and every cluster but its own: the API
  // refuses the same-cluster move, but offering it would be offering a no-op.
  const moveTargets = hasRole(session, Role.ADMIN)
    ? (
        await prisma.cluster.findMany({
          where: { id: { not: project.clusterId } },
          select: { id: true, name: true, _count: { select: { registries: true } } },
          orderBy: { name: "asc" },
        })
      ).map((cluster) => ({
        id: cluster.id,
        name: cluster.name,
        memberCount: cluster._count.registries,
      }))
    : []

  const usersById = new Map(memberUsers.map((user) => [user.id, user]))
  const harborUsernameById = new Map(
    memberIdentities.map((identity) => [identity.userId, identity.harborUsername])
  )

  // Every cluster member gets a row, including one that joined after approval and has no
  // placement yet — a missing row is exactly the state the reconciler is there to fix, so
  // hiding it would hide the problem.
  const placementsByRegistry = new Map(project.placements.map((p) => [p.registryId, p]))
  const harborPlacements: HarborPlacement[] = project.cluster.registries.map((registry) => {
    const placement = placementsByRegistry.get(registry.id)
    return {
      registryId: registry.id,
      registryName: registry.name,
      baseUrl: registry.baseUrl,
      harborProjectId: placement?.harborProjectId ?? null,
      status: placement?.status ?? "MISSING",
      lastError: placement?.lastError ?? null,
      syncedAt: placement?.syncedAt?.toISOString() ?? null,
    }
  })
  const syncedHarbors = harborPlacements.filter((placement) => placement.status === "ACTIVE").length
  const totalHarbors = harborPlacements.length

  const statusBadge =
    project.status === "ACTIVE" ? (
      <Badge className="bg-success/15 text-success">{t("statusActive")}</Badge>
    ) : project.status === "PENDING" ? (
      <Badge className="bg-warning/15 text-warning">{t("statusPending")}</Badge>
    ) : (
      <Badge variant="destructive">{t("statusRejected")}</Badge>
    )

  return (
    <>
      <PageBreadcrumb crumbs={[{ label: tNav("projects"), href: returnTo }, { label: project.name }]} />

      <PageHeader
        size="lg"
        back={{ href: returnTo, label: tNav("projects") }}
        title={project.name}
        badges={
          <>
            {statusBadge}
            <Badge variant="outline" className="gap-1 font-normal">
              {project.isPublic ? <Globe2 /> : <LockKeyhole />}
              {project.isPublic ? t("public") : t("private")}
            </Badge>
          </>
        }
        description={project.description}
        meta={
          <>
            <span>{project.cluster.name}</span>
            <MetaDot />
            <span>{t("harborsCount", { count: totalHarbors })}</span>
            {isManager && (
              <>
                <MetaDot />
                <span className="inline-flex items-center gap-1">
                  <ShieldCheck className="size-3.5" />
                  {t("detail.managerAccess")}
                </span>
              </>
            )}
          </>
        }
        action={
          isManager ? (
            <div className="flex w-full gap-2 sm:w-auto [&_[data-slot=button]]:flex-1 sm:[&_[data-slot=button]]:flex-none">
              {moveTargets.length > 0 && (
                <MoveProjectDialog id={project.id} name={project.name} clusters={moveTargets} />
              )}
              <DeleteProjectButton id={project.id} name={project.name} returnTo={returnTo} />
            </div>
          ) : (
            // Everybody else asks instead of acting. Offered to members only: a stranger looking
            // at a public project has no standing to propose destroying it, and the endpoint
            // would take it anyway — this is the half that says who it is *for*.
            isMember && (
              <RequestProjectDeleteDialog
                id={project.id}
                name={project.name}
                pending={hasPendingDeleteRequest}
              />
            )
          )
        }
      >
        <MetricGrid
          metrics={[
            { icon: Users, label: t("detail.metricMembers"), value: project.members.length },
            { icon: Bot, label: t("detail.metricRobots"), value: project.robotAccounts.length },
            { icon: Download, label: t("detail.metricTransfers"), value: project.transferTargets.length },
            {
              icon: Server,
              label: t("detail.metricHarborsInSync"),
              value: `${syncedHarbors}/${totalHarbors}`,
              tone: syncedHarbors < totalHarbors ? "warning" : "default",
            },
          ]}
        />
      </PageHeader>

    <div className="flex flex-col gap-5 px-4 lg:px-6">
      {project.status === "REJECTED" && project.rejectionReason && (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive"
        >
          <CircleAlert className="mt-0.5 size-4 shrink-0" />
          <div>
            <p className="font-medium">{t("detail.rejectedTitle")}</p>
            <p className="mt-0.5 opacity-90">{project.rejectionReason}</p>
          </div>
        </div>
      )}
      {project.status === "PENDING" && (
        <div
          role="status"
          className="flex items-start gap-3 rounded-lg border border-warning/30 bg-warning/5 px-4 py-3 text-sm text-warning"
        >
          <Clock3 className="mt-0.5 size-4 shrink-0" />
          <div>
            <p className="font-medium">{t("detail.pendingTitle")}</p>
            <p className="mt-0.5 opacity-90">{t("detail.pendingDescription")}</p>
          </div>
        </div>
      )}

      <UrlTabs
        param="tab"
        values={["images", "members", "robots", "retention", "quota", "security", "transfers", "harbors"]}
        fallback="images"
        className="gap-0"
      >
        <div className="relative max-w-full border-b pb-1">
          <div className="scrollbar-none max-w-full overflow-x-auto pr-7 sm:pr-0">
          <TabsList variant="line" className="h-9 w-max justify-start rounded-none p-0">
            <TabsTrigger value="images" className="flex-none px-3">
              <Package />
              {t("detail.tabImages")}
            </TabsTrigger>
            <TabsTrigger value="members" className="flex-none px-3">
              <Users />
              {t("detail.tabMembers")}
            </TabsTrigger>
            <TabsTrigger value="robots" className="flex-none px-3">
              <Bot />
              {t("detail.tabRobots")}
            </TabsTrigger>
            <TabsTrigger value="retention" className="flex-none px-3">
              <ShieldCheck />
              {t("detail.tabRetention")}
            </TabsTrigger>
            <TabsTrigger value="quota" className="flex-none px-3">
              <Gauge />
              {t("detail.tabQuota")}
            </TabsTrigger>
            <TabsTrigger value="security" className="flex-none px-3">
              <RadioTower />
              {t("detail.tabSecurity")}
            </TabsTrigger>
            <TabsTrigger value="transfers" className="flex-none px-3">
              <Download />
              {t("detail.tabTransfers")}
            </TabsTrigger>
            <TabsTrigger value="harbors" className="flex-none px-3">
              <Server />
              {t("detail.tabHarbors")}
            </TabsTrigger>
          </TabsList>
          </div>
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-linear-to-l from-background to-transparent sm:hidden"
          />
        </div>
        <TabsContent value="images" className="pt-4">
          <ProjectImagesTab
            projectId={project.id}
            projectName={project.name}
            registryHost={project.cluster.registryUrl}
            isActive={project.status === "ACTIVE" && syncedHarbors > 0}
            canScan={hasRole(session, Role.ADMIN)}
            canDelete={canWriteImages}
          />
        </TabsContent>
        <TabsContent value="members" className="pt-4">
          <ProjectMembersTab
            projectId={project.id}
            clusterId={project.clusterId}
            identityMode={project.cluster.identityMode}
            members={project.members.map((member) => ({
              id: member.id,
              userId: member.userId,
              role: member.role,
              username: usersById.get(member.userId)?.username ?? null,
              name: usersById.get(member.userId)?.name ?? null,
              harborUsername: harborUsernameById.get(member.userId) ?? null,
            }))}
            groups={project.groups.map((group) => ({
              id: group.id,
              groupName: group.groupName,
              role: group.role,
            }))}
            ownerUserId={project.ownerUserId}
            isManager={isManager}
            isAdmin={hasRole(session, Role.ADMIN)}
          />
        </TabsContent>
        <TabsContent value="robots" className="pt-4">
          <ProjectRobotsTab
            projectId={project.id}
            robots={project.robotAccounts.map((r) => ({
              id: r.id,
              name: r.name,
              expiresAt: r.expiresAt?.toISOString() ?? null,
              createdAt: r.createdAt.toISOString(),
              unifiedSecret: r.unifiedSecret,
              syncedCount: r.placements.filter((p) => p.status === "ACTIVE").length,
              memberCount: project.cluster.registries.length,
            }))}
            isManager={isManager}
            isActive={project.status === "ACTIVE"}
          />
        </TabsContent>
        <TabsContent value="retention" className="pt-4">
          <ProjectRetentionTab
            projectId={project.id}
            retention={
              project.retentionPolicy
                ? { keepLastN: project.retentionPolicy.keepLastN, tagPattern: project.retentionPolicy.tagPattern }
                : null
            }
            isManager={isManager}
            isActive={project.status === "ACTIVE"}
          />
        </TabsContent>
        <TabsContent value="quota" className="pt-4">
          <ProjectQuotaTab
            projectId={project.id}
            storageQuotaMib={project.storageQuotaMib}
            canEdit={hasRole(session, Role.ADMIN)}
            canRequest={isManager}
            pendingRequest={
              project.quotaRequests[0]
                ? { requestedQuotaMib: project.quotaRequests[0].requestedQuotaMib }
                : null
            }
            isActive={project.status === "ACTIVE"}
          />
        </TabsContent>
        <TabsContent value="security" className="pt-4">
          <ProjectSecurityTab
            projectId={project.id}
            autoScan={project.autoScan}
            autoSbom={project.autoSbom}
            canEdit={hasRole(session, Role.ADMIN)}
            isActive={project.status === "ACTIVE"}
          />
        </TabsContent>
        <TabsContent value="transfers" className="pt-4">
          <ProjectTransfersTab
            projectId={project.id}
            targets={project.transferTargets.map((target) => ({
              id: target.id,
              transferRequestId: target.transferRequestId,
              sourceImage: target.transferRequest.sourceImage,
              sourceName: target.transferRequest.source?.name ?? null,
              targetRepo: target.targetRepo,
              status: target.status,
              errorMessage: target.errorMessage ?? target.transferRequest.rejectionReason,
            }))}
            sources={sources}
            sourceRegistries={sourceRegistries}
            destinations={destinations}
            isActive={project.status === "ACTIVE"}
            canTransferDirectly={hasRole(session, Role.ADMIN)}
            hasEnterpriseCa={hasEnterpriseCa}
            enterpriseCaJobDefault={enterpriseCaJobDefault}
            k8sEnabled={getConfig().k8sEnabled}
          />
        </TabsContent>
        <TabsContent value="harbors" className="pt-4">
          <ProjectHarborsTab
            clusterId={project.clusterId}
            clusterName={project.cluster.name}
            clusterRegistryUrl={project.cluster.registryUrl}
            projectName={project.name}
            replicationMode={project.cluster.replicationMode}
            placements={harborPlacements}
            isManager={isManager}
          />
        </TabsContent>
      </UrlTabs>
    </div>
    </>
  )
}
