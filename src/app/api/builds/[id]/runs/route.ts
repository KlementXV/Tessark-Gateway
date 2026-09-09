import { prisma } from "@/lib/prisma"
import { buildSession, loadBuild } from "@/lib/builds/access"
import { buildResponse } from "@/lib/builds/http"
import { publicRun } from "@/lib/builds/public"
export async function GET(request: Request, c: { params: Promise<{ id: string }> }) { return buildResponse(async () => {
  const { id } = await c.params; await loadBuild(id, await buildSession(request))
  const page = Math.max(0, Math.min(10000, Number(new URL(request.url).searchParams.get("page")) || 0))
  const runs = await prisma.buildRun.findMany({ where: { buildId: id }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: Math.floor(page) * 20, take: 21 })
  return { runs: runs.slice(0, 20).map(publicRun), hasMore: runs.length > 20 }
}) }
