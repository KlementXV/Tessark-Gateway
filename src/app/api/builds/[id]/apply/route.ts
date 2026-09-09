import { buildSession, loadBuild } from "@/lib/builds/access"
import { buildResponse } from "@/lib/builds/http"
import { applyBuild } from "@/lib/builds/service"
export async function POST(request: Request, c: { params: Promise<{ id: string }> }) { return buildResponse(async () => {
  const { id } = await c.params; await loadBuild(id, await buildSession(request)); return applyBuild(id)
}, 200) }
