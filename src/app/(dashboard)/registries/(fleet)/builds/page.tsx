import { getTranslations } from "next-intl/server"
import { auth } from "@/auth"
import { requireRole } from "@/lib/auth/guard"
import { Role } from "@/generated/prisma/client"
import { prisma } from "@/lib/prisma"
import { getConfig } from "@/lib/config"
import { listBuilds } from "@/lib/builds/service"
import { BuildsBoard } from "@/components/builds/builds-board"
import { PageHeader } from "@/components/layout/page-header"
export async function generateMetadata() { return { title: (await getTranslations("builds"))("title") } }
export default async function BuildsPage() {
  const session = await auth(); requireRole(session, Role.ADMIN)
  const [builds, projects, t] = await Promise.all([listBuilds(session), prisma.project.findMany({ where: { status: "ACTIVE" }, select: { id: true, name: true }, orderBy: { name: "asc" } }), getTranslations("builds")])
  const config = getConfig()
  return <><PageHeader title={t("title")} description={t("description")} /><BuildsBoard builds={builds} projects={projects} enabled={config.buildsBetaEnabled && config.k8sEnabled && !!config.buildsRunnerImage} /></>
}
