import { revalidatePath } from "next/cache"
import { NextResponse } from "next/server"

import { authenticateRequest, authErrorResponse, requireRole } from "@/lib/auth/guard"
import { getConfig } from "@/lib/config"
import { Role } from "@/generated/prisma/client"
import { validateLogoBytes } from "@/lib/settings/logo"
import { deleteInstanceLogo, getInstanceLogo, saveInstanceLogo } from "@/lib/settings/service"

/**
 * Public — the login page shows the logo to anonymous visitors, so this path is
 * allowlisted in the middleware (see src/proxy.ts).
 */
export async function GET() {
  const logo = await getInstanceLogo()
  if (!logo) return new NextResponse(null, { status: 404 })

  return new NextResponse(new Uint8Array(logo.data), {
    headers: {
      "Content-Type": logo.mimeType,
      "Content-Length": String(logo.data.byteLength),
      // `logoUrl` carries a ?v= stamp that changes on every upload, so the bytes
      // behind a given URL are immutable.
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
      // An uploaded SVG is same-origin markup. Rendered through <img> it is inert,
      // but a direct visit would execute any embedded script — the sandbox and the
      // empty default-src close that off.
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    },
  })
}

export async function POST(request: Request) {
  try {
    requireRole(await authenticateRequest(request), Role.SUPERADMIN)
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: "Unexpected error" }, { status: 500 })
  }

  const maxBytes = getConfig().logoMaxBytes
  const form = await request.formData().catch(() => null)
  const file = form?.get("file")
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No file uploaded" }, { status: 400 })
  }
  // Cheap rejection before buffering the whole body into memory.
  if (file.size > maxBytes) {
    return NextResponse.json(
      { error: `Logo must be ${Math.round(maxBytes / 1024)} KB or smaller` },
      { status: 413 },
    )
  }

  const bytes = new Uint8Array(await file.arrayBuffer())
  const result = validateLogoBytes(bytes, maxBytes)
  if (!result.ok) {
    return NextResponse.json({ error: result.error.message }, { status: 400 })
  }

  const settings = await saveInstanceLogo(bytes, result.mimeType)
  revalidatePath("/", "layout")
  return NextResponse.json(settings)
}

export async function DELETE(request: Request) {
  try {
    requireRole(await authenticateRequest(request), Role.SUPERADMIN)
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: "Unexpected error" }, { status: 500 })
  }

  const settings = await deleteInstanceLogo()
  revalidatePath("/", "layout")
  return NextResponse.json(settings)
}
