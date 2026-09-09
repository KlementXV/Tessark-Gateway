import { revalidatePath } from "next/cache"
import { NextResponse } from "next/server"

import { authenticateRequest, authErrorResponse, requireRole } from "@/lib/auth/guard"
import { Role } from "@/generated/prisma/client"
import { instanceSettingsInputSchema } from "@/lib/settings/schema"
import { getInstanceSettings, updateInstanceSettings } from "@/lib/settings/service"

export async function GET() {
  return NextResponse.json(await getInstanceSettings())
}

export async function PATCH(request: Request) {
  try {
    requireRole(await authenticateRequest(request), Role.SUPERADMIN)
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: "Unexpected error" }, { status: 500 })
  }

  const body = await request.json().catch(() => null)
  const parsed = instanceSettingsInputSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  }

  const settings = await updateInstanceSettings(parsed.data)

  // Branding is baked into the root layout (theme vars, metadata) and the sidebar
  // of every page, so drop the whole tree rather than just this route's cache.
  revalidatePath("/", "layout")

  return NextResponse.json(settings)
}
