// Profile pictures. GET is open to any signed-in user so avatars can be rendered wherever
// people are listed; writes are restricted to the owner (a SUPERADMIN may also clear or
// replace someone else's, same reach they already have over the rest of a user row).
import { revalidatePath } from "next/cache"
import { NextResponse } from "next/server"

import { authenticateRequest, AuthError, authErrorResponse, hasRole, requireUser } from "@/lib/auth/guard"
import { getConfig } from "@/lib/config"
import { Role } from "@/generated/prisma/client"
import { validateAvatarBytes } from "@/lib/users/avatar"
import { deleteUserAvatar, getUserAvatar, saveUserAvatar } from "@/lib/users/profile"
import type { Session } from "next-auth"

type Params = { params: Promise<{ id: string }> }

function requireOwnerOrSuperadmin(session: Session | null, id: string): asserts session is Session {
  requireUser(session)
  if (session.user.id !== id && !hasRole(session, Role.SUPERADMIN)) {
    throw new AuthError("Not authorized", 403)
  }
}

export async function GET(request: Request, { params }: Params) {
  try {
    requireUser(await authenticateRequest(request))
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: "Unexpected error" }, { status: 500 })
  }

  const { id } = await params
  const avatar = await getUserAvatar(id)
  if (!avatar) return new NextResponse(null, { status: 404 })

  return new NextResponse(new Uint8Array(avatar.data), {
    headers: {
      "Content-Type": avatar.mimeType,
      "Content-Length": String(avatar.data.byteLength),
      // The URL carries a ?v= stamp that changes on every upload, so the bytes behind a
      // given URL are immutable — but they are another user's picture, so keep the cache
      // private to this browser.
      "Cache-Control": "private, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    },
  })
}

export async function POST(request: Request, { params }: Params) {
  const { id } = await params
  try {
    requireOwnerOrSuperadmin(await authenticateRequest(request), id)
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: "Unexpected error" }, { status: 500 })
  }

  const maxBytes = getConfig().avatarMaxBytes
  const form = await request.formData().catch(() => null)
  const file = form?.get("file")
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No file uploaded" }, { status: 400 })
  }
  // Cheap rejection before buffering the whole body into memory.
  if (file.size > maxBytes) {
    return NextResponse.json(
      { error: `Picture must be ${Math.round(maxBytes / 1024)} KB or smaller` },
      { status: 413 },
    )
  }

  const bytes = new Uint8Array(await file.arrayBuffer())
  const result = validateAvatarBytes(bytes, maxBytes)
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 })
  }

  const profile = await saveUserAvatar(id, bytes, result.mimeType)
  // The sidebar renders the avatar on every page.
  revalidatePath("/", "layout")
  return NextResponse.json(profile)
}

export async function DELETE(request: Request, { params }: Params) {
  const { id } = await params
  try {
    requireOwnerOrSuperadmin(await authenticateRequest(request), id)
  } catch (err) {
    return authErrorResponse(err) ?? NextResponse.json({ error: "Unexpected error" }, { status: 500 })
  }

  const profile = await deleteUserAvatar(id)
  revalidatePath("/", "layout")
  return NextResponse.json(profile)
}
