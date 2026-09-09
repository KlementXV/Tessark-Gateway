import { prisma } from "@/lib/prisma"
import { AuthError } from "@/lib/auth/guard"
import { buildSession, loadBuild } from "@/lib/builds/access"
import { buildResponse } from "@/lib/builds/http"
import { buildLogs } from "@/lib/builds/k8s"
export async function GET(request: Request, c: { params: Promise<{ id: string; runId: string }> }) { return buildResponse(async () => {
  const { id, runId } = await c.params; await loadBuild(id, await buildSession(request))
  const run = await prisma.buildRun.findFirst({ where: { id: runId, buildId: id } })
  if (!run) throw new AuthError("Run not found", 404)
  const container = new URL(request.url).searchParams.get("container") === "claim" ? "claim" : "build"
  return buildLogs(run.jobName, container)
}) }
