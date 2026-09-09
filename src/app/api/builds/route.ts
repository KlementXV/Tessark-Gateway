import { buildSession } from "@/lib/builds/access"
import { buildResponse } from "@/lib/builds/http"
import { buildInputSchema } from "@/lib/builds/schema"
import { listBuilds, saveBuild } from "@/lib/builds/service"
export async function GET(request: Request) { return buildResponse(async () => listBuilds(await buildSession(request))) }
export async function POST(request: Request) { return buildResponse(async () => {
  const session = await buildSession(request)
  return saveBuild(buildInputSchema.parse(await request.json().catch(() => null)), session)
}, 201) }
