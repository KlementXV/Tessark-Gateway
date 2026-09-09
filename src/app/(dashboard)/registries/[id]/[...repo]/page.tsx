import { redirect } from "next/navigation"

import { prisma } from "@/lib/prisma"

// Old catalogue bookmarks now open the owning project's image view. Project access is
// checked by that page; repositories without a Gateway project return to the project list.
export default async function LegacyRegistryRepositoryPage({ params }: {
  params: Promise<{ id: string; repo: string[] }>
}) {
  const { id, repo } = await params
  const projectName = repo[0]
  if (!projectName) redirect("/projects")
  const placement = await prisma.projectPlacement.findFirst({
    where: { registryId: id, project: { name: projectName } },
    select: { projectId: true },
  })
  redirect(placement ? `/projects/${encodeURIComponent(placement.projectId)}?tab=images` : "/projects")
}
