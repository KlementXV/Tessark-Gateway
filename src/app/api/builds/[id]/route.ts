import { buildSession, loadBuild } from "@/lib/builds/access"
import { buildResponse } from "@/lib/builds/http"
import { publicBuild } from "@/lib/builds/public"
import { buildInputSchema, buildToggleSchema } from "@/lib/builds/schema"
import { deleteBuild, pauseBuild, saveBuild } from "@/lib/builds/service"
type Context = { params: Promise<{ id: string }> }
export async function GET(request: Request, c: Context) { return buildResponse(async () => publicBuild(await loadBuild((await c.params).id, await buildSession(request)))) }
export async function PATCH(request: Request, c: Context) { return buildResponse(async () => {
  const session = await buildSession(request); const { id } = await c.params
  const build = await loadBuild(id, session)
  const body = await request.json().catch(() => null)
  const toggle = buildToggleSchema.safeParse(body)
  if (toggle.success) return toggle.data.enabled
    ? saveBuild(buildInputSchema.parse({ ...JSON.parse(build.config), enabled: true }), session, id)
    : pauseBuild(id)
  return saveBuild(buildInputSchema.parse(body), session, id)
}) }
export async function DELETE(request: Request, c: Context) { return buildResponse(async () => {
  const { id } = await c.params; await loadBuild(id, await buildSession(request))
  return { deleted: await deleteBuild(id) }
}, 202) }
